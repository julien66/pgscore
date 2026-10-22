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
import { competitionStandings } from "../src/standings.js";
import { TrackStore } from "../src/track-store.js";

/**
 * Compétition entière de bout en bout : US Open of Paragliding 2026 (Chelan, FS formule GAP2025, 3 manches),
 * importée depuis civlcomps.org comme le fait l'appli, calculée comme après un import, puis comparée aux points
 * FS publiés sur les pages des manches. Seule compétition de référence en leading GAP2025.
 * civlcomps.org n'est pas sollicité : le test rejoue une copie des 7 réponses (index.json : adresse → fichier),
 * gardée sur la branche test-data du dépôt. Son chemin est donné par US_OPEN_2026_ZIP
 * (scripts/fetch-test-tracks.sh).
 *
 * Particularités de cette compétition :
 * - FS a arrêté la manche 1 sans que l'arrêt soit publié sur civlcomps : l'heure d'annonce, 17:50 locale
 *   (00:50 UTC, après minuit), est déduite des points et réglée après l'import ;
 * - quelques écarts connus sont tolérés à part (KNOWN), chacun expliqué.
 */
const ZIP = process.env.US_OPEN_2026_ZIP;
const URL_ = "https://civlcomps.org/event/us-open-of-paragliding-2026";

/** Écart maximal sur le total d'un pilote, par manche puis au général, en points. */
const TASK_TOLERANCE = 0.5;
const OVERALL_TOLERANCE = 1;

/** Écarts connus, par manche : numéro du pilote → raison. Ces pilotes sont sortis de la comparaison. */
const KNOWN: Record<number, Record<string, string>> = {
  2: {
    // Points ajoutés à la main dans FS, sans pénalité ni bonus publiés (921,8 → 966,5 et 913,2 → 920,0).
    "259": "Shoemaker : correction manuelle FS (+44,7)",
    "5368": "Fletcher : correction manuelle FS (+6,8)",
  },
};

describe.skipIf(!ZIP || !existsSync(ZIP))("US Open 2026 (Chelan) : import civlcomps et calcul complet", () => {
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

    const store = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-uso-")));
    db = openDb(":memory:", store);
    db.prepare("INSERT INTO users (id, provider, subject, created_at) VALUES (1, 'dev', 'test', 0)").run();
    const { a, files } = await civlToArchive(URL_, replay, store);
    const r = writeArchive(db, store, 1, a, files);
    const t1 = db.prepare("SELECT id, task FROM tasks WHERE competition_id = ? AND number = 1").get(r.id) as { id: number; task: string };
    db.prepare("UPDATE tasks SET task = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(t1.task), stopAnnouncement: "00:50:00" }), t1.id);
    // Les pages civlcomps de l'US Open ne donnent pas le FTV : 25 %, celui qui reproduit le général publié.
    const params = db.prepare("SELECT params FROM competitions WHERE id = ?").get(r.id) as { params: string };
    db.prepare("UPDATE competitions SET params = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(params.params), ftvFactor: 0.25 }), r.id);
    comp = db.prepare("SELECT * FROM competitions WHERE id = ?").get(r.id) as unknown as CompetitionRow;
    const ids = (db.prepare("SELECT id FROM tasks WHERE competition_id = ? ORDER BY number").all(r.id) as Array<{ id: number }>).map((x) => x.id);
    startRuns(db, store, ids, 1);
    while (ids.some(isRunning)) await new Promise((res) => setTimeout(res, 200));
  }, 600_000);

  /** Pilotes classés par FS dans une manche (ni absents, ni sans total publié). */
  const published = (n: number) => pages[n - 1]!.pilots.filter((p) => p.total !== null && /^\d+$/.test(p.rank));

  it("lit la formule GAP2025 de FS", () => {
    const tasks = db.prepare("SELECT task FROM tasks WHERE competition_id = ? ORDER BY number").all(comp.id) as Array<{ task: string }>;
    expect(tasks.map((t) => JSON.parse(t.task).leadingFormula)).toEqual(["GAP2025", "GAP2025", "GAP2025"]);
  });

  for (const n of [1, 2, 3]) {
    it(`manche ${n} : total de chaque pilote à ${TASK_TOLERANCE} point près, hors écarts connus`, () => {
      const task = db.prepare("SELECT id FROM tasks WHERE competition_id = ? AND number = ?").get(comp.id, n) as { id: number };
      const detail = competitionStandings(db, comp, { task: task.id }).view?.detail;
      expect(detail, "manche non calculée").toBeTruthy();
      const known = KNOWN[n] ?? {};
      const off: string[] = [];
      const stillOff = new Set<string>();
      for (const row of published(n)) {
        const p = detail!.results.pilots.find((x) => x.id === row.key);
        const bad = !p || Math.abs((p.total ?? 0) - row.total!) > TASK_TOLERANCE;
        if (row.key in known) {
          if (bad) stillOff.add(row.key);
        } else if (!p) off.push(`${row.key} : absent`);
        else if (bad) off.push(`${row.key} : ${p.total} au lieu de ${row.total}`);
      }
      expect(off).toEqual([]);
      // Un écart connu qui disparaît doit être retiré de KNOWN.
      expect([...stillOff].sort()).toEqual(Object.keys(known).sort());
    });
  }

  it(`classement général à ${OVERALL_TOLERANCE} point près du général tiré des points FS, hors écarts connus`, () => {
    // Le général est refait (FTV 25 %) à partir des points FS des manches, corrigés des écarts connus : les
    // pilotes concernés gardent nos points sur la manche en cause.
    const ours = competitionStandings(db, comp);
    const fs = competitionRanking(
      [1, 2, 3].map((n) => ({ key: `T${n}`, results: published(n).map((p) => ({ pilot: p.key, name: p.name, total: p.total })) })),
      0.25,
    );
    const knownPilots = new Set(Object.values(KNOWN).flatMap((k) => Object.keys(k)));
    const off: string[] = [];
    for (const p of fs.pilots) {
      if (knownPilots.has(p.pilot)) continue;
      const o = ours.ranking.pilots.find((x) => x.pilot === p.pilot);
      if (!o || Math.abs(o.total - p.total) > OVERALL_TOLERANCE) off.push(`${p.pilot} : ${o?.total.toFixed(1)} au lieu de ${p.total.toFixed(1)}`);
    }
    expect(off).toEqual([]);
    expect(ours.ranking.pilots.slice(0, 10).map((p) => p.pilot)).toEqual(fs.pilots.slice(0, 10).map((p) => p.pilot));
  });
});
