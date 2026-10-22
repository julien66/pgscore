import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { competitionRanking } from "@pgscore/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { writeArchive } from "../src/archive.js";
import { civlToArchive, parseEventPage, parseTaskPage, type CivlTaskPage, type Fetcher } from "../src/civlcomps.js";
import { openDb, type CompetitionRow, type Db } from "../src/db.js";
import { isRunning, startRuns } from "../src/runner.js";
import { parseSettings, type CompetitionSettings } from "../src/settings.js";
import { competitionStandings } from "../src/standings.js";
import { TrackStore } from "../src/track-store.js";

/**
 * Compétition entière de bout en bout : German Open 2026 (FS, 5 manches), importée depuis civlcomps.org
 * comme le fait l'appli (page de résultats, pages des manches, ZIP des traces), calculée comme après un
 * import, puis comparée aux points FS publiés sur les pages des manches.
 * civlcomps.org n'est pas sollicité : le test rejoue une copie des 11 réponses, enregistrée une fois
 * (index.json : adresse → fichier) et gardée sur la branche test-data du dépôt. Son chemin est donné par
 * GERMAN_OPEN_2026_ZIP (scripts/fetch-test-tracks.sh).
 *
 * Deux particularités de cette compétition :
 * - le ZIP de traces de la manche 1 publié par civlcomps coupe les traces juste avant la ligne de goal ; la
 *   copie contient à la place le lot Flymaster de la même manche, complet ;
 * - les résultats publiés prennent la dernière arrivée à l'ESS comme fin de manche pour le leading (maxtime
 *   de Flymaster : 16:42:18 en manche 1) et orientent la ligne de goal de la manche 1 vers le centre de la balise
 *   précédente (S7F 2024 ; la manche 5, en ligne aussi, suit l'optimisé) : la compétition et la manche 1 sont
 *   réglées ainsi après l'import.
 */
const ZIP = process.env.GERMAN_OPEN_2026_ZIP;
const URL_ = "https://civlcomps.org/event/german-open-2026";

/** Écart maximal sur le total d'un pilote, par manche puis au général, en points. */
const TASK_TOLERANCE = 0.5;
const OVERALL_TOLERANCE = 1;

describe.skipIf(!ZIP || !existsSync(ZIP))("German Open 2026 : import civlcomps et calcul complet", () => {
  let db: Db;
  let comp: CompetitionRow;
  const pages: CivlTaskPage[] = [];

  beforeAll(async () => {
    const snapshot = unzipSync(readFileSync(ZIP!));
    const index = JSON.parse(strFromU8(snapshot["index.json"]!)) as Record<string, string>;
    const replay: Fetcher = async (url) => {
      const file = index[url];
      if (!file) throw new Error(`Pas dans la copie de civlcomps : ${url}`);
      return snapshot[file]!;
    };
    const event = parseEventPage(strFromU8(await replay(`${URL_}/results`)));
    for (const link of event.tasks) pages.push(parseTaskPage(strFromU8(await replay(link.results[0]!.url))));

    const store = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-go-")));
    db = openDb(":memory:", store);
    db.prepare("INSERT INTO users (id, provider, subject, created_at) VALUES (1, 'dev', 'test', 0)").run();
    const { a, files } = await civlToArchive(URL_, replay, store);
    const r = writeArchive(db, store, 1, a, files);
    const params = (db.prepare("SELECT params FROM competitions WHERE id = ?").get(r.id) as { params: string }).params;
    const settings: CompetitionSettings = { ...parseSettings(params), leadingEnd: "lastEss" };
    db.prepare("UPDATE competitions SET params = ? WHERE id = ?").run(JSON.stringify(settings), r.id);
    const t1 = db.prepare("SELECT id, task FROM tasks WHERE competition_id = ? AND number = 1").get(r.id) as { id: number; task: string };
    db.prepare("UPDATE tasks SET task = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(t1.task), goalLineOrientation: "previousCentre" }), t1.id);
    comp = db.prepare("SELECT * FROM competitions WHERE id = ?").get(r.id) as unknown as CompetitionRow;
    const ids = (db.prepare("SELECT id FROM tasks WHERE competition_id = ? ORDER BY number").all(r.id) as Array<{ id: number }>).map((x) => x.id);
    startRuns(db, store, ids, 1);
    while (ids.some(isRunning)) await new Promise((res) => setTimeout(res, 200));
  }, 600_000);

  /** Pilotes classés par FS dans une manche (ni absents, ni sans total publié). */
  const published = (n: number) => pages[n - 1]!.pilots.filter((p) => p.total !== null && /^\d+$/.test(p.rank));

  for (const n of [1, 2, 3, 4, 5]) {
    it(`manche ${n} : total de chaque pilote à ${TASK_TOLERANCE} point près`, () => {
      const task = db.prepare("SELECT id FROM tasks WHERE competition_id = ? AND number = ?").get(comp.id, n) as { id: number };
      const detail = competitionStandings(db, comp, { task: task.id }).view?.detail;
      expect(detail, "manche non calculée").toBeTruthy();
      const off: string[] = [];
      for (const row of published(n)) {
        const p = detail!.results.pilots.find((x) => x.id === row.key);
        if (!p) off.push(`${row.key} : absent`);
        else if (Math.abs((p.total ?? 0) - row.total!) > TASK_TOLERANCE) off.push(`${row.key} : ${p.total} au lieu de ${row.total}`);
      }
      expect(off).toEqual([]);
    });
  }

  it(`classement général à ${OVERALL_TOLERANCE} point près du général tiré des points FS`, () => {
    // Le général publié n'est pas dans la copie : on le refait (FTV 25 %) à partir des points FS des manches.
    const fs = competitionRanking(
      [1, 2, 3, 4, 5].map((n) => ({ key: `T${n}`, results: published(n).map((p) => ({ pilot: p.key, name: p.name, total: p.total })) })),
      0.25,
    );
    const ours = competitionStandings(db, comp).ranking;
    const off: string[] = [];
    for (const p of fs.pilots) {
      const o = ours.pilots.find((x) => x.pilot === p.pilot);
      if (!o || Math.abs(o.total - p.total) > OVERALL_TOLERANCE) off.push(`${p.pilot} : ${o?.total.toFixed(1)} au lieu de ${p.total.toFixed(1)}`);
    }
    expect(off).toEqual([]);
    expect(ours.pilots.slice(0, 10).map((p) => p.pilot)).toEqual(fs.pilots.slice(0, 10).map((p) => p.pilot));
  });
});
