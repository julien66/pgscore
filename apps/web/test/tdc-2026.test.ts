import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { writeArchive } from "../src/archive.js";
import { openDb, type CompetitionRow, type Db } from "../src/db.js";
import { fsdbToArchive } from "../src/fsdb.js";
import { isRunning, startRuns } from "../src/runner.js";
import { competitionStandings } from "../src/standings.js";
import { TrackStore } from "../src/track-store.js";
import { child, children, parseXml, type XmlEl } from "../src/xml.js";

/**
 * Compétition entière de bout en bout : French Open - Trophées des Cimes 2026 (FS, 5 manches), importée
 * depuis son ZIP FS (.fsdb nettoyé des données personnelles + traces), calculée par l'appli comme après
 * un import, puis comparée aux résultats FS enregistrés dans le .fsdb, manche par manche et au général.
 * Le ZIP est sur la branche test-data du dépôt : son chemin est donné par TDC_2026_ZIP
 * (scripts/fetch-test-tracks.sh).
 */
const ZIP = process.env.TDC_2026_ZIP;

/** Écart maximal sur le total d'un pilote, par manche puis au général, en points. */
const TASK_TOLERANCE = 0.5;
const OVERALL_TOLERANCE = 1;

describe.skipIf(!ZIP || !existsSync(ZIP))("French Open - Trophées des Cimes 2026 : import FS et calcul complet", () => {
  let db: Db;
  let comp: CompetitionRow;
  let fs: XmlEl;

  beforeAll(async () => {
    const bytes = readFileSync(ZIP!);
    const name = Object.keys(unzipSync(bytes, { filter: (f) => /\.fsdb$/i.test(f.name) }))[0]!;
    fs = child(child(parseXml(strFromU8(unzipSync(bytes, { filter: (f) => f.name === name })[name]!)), "Fs"), "FsCompetition")!;

    const store = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-tdc-")));
    db = openDb(":memory:", store);
    db.prepare("INSERT INTO users (id, provider, subject, created_at) VALUES (1, 'dev', 'test', 0)").run();
    const { a, files } = fsdbToArchive(bytes, store);
    const r = writeArchive(db, store, 1, a, files);
    comp = db.prepare("SELECT * FROM competitions WHERE id = ?").get(r.id) as unknown as CompetitionRow;
    const ids = (db.prepare("SELECT id FROM tasks WHERE competition_id = ? ORDER BY number").all(r.id) as Array<{ id: number }>).map((x) => x.id);
    startRuns(db, store, ids, 1);
    while (ids.some(isRunning)) await new Promise((res) => setTimeout(res, 200));
  }, 600_000);

  /** Résultats FS d'une manche : id du pilote → points (sans les absents, sans trace et à 0 point). */
  const fsTask = (n: number): Map<string, number> => {
    const ft = children(child(fs, "FsTasks"), "FsTask").find((t) => Number(t.attrs.id) === n)!;
    const out = new Map<string, number>();
    for (const p of children(child(ft, "FsParticipants"), "FsParticipant")) {
      const r = child(p, "FsResult");
      const flew = Object.keys(child(p, "FsFlightData")?.attrs ?? {}).length > 0;
      if (r && (flew || Number(r.attrs.points) !== 0)) out.set(p.attrs.id!, Number(r.attrs.points));
    }
    return out;
  };

  for (const n of [1, 2, 3, 4, 5]) {
    it(`manche ${n} : total de chaque pilote à ${TASK_TOLERANCE} point près`, () => {
      const task = db.prepare("SELECT id FROM tasks WHERE competition_id = ? AND number = ?").get(comp.id, n) as { id: number };
      const detail = competitionStandings(db, comp, { task: task.id }).view?.detail;
      expect(detail, "manche non calculée").toBeTruthy();
      const off: string[] = [];
      for (const [id, points] of fsTask(n)) {
        const p = detail!.results.pilots.find((x) => x.id === id);
        if (!p) off.push(`${id} : absent`);
        else if (Math.abs((p.total ?? 0) - points) > TASK_TOLERANCE) off.push(`${id} : ${p.total} au lieu de ${points}`);
      }
      expect(off).toEqual([]);
    });
  }

  it(`classement général à ${OVERALL_TOLERANCE} point près`, () => {
    // Dernière version du général FS (toutes les manches).
    const overall = children(child(fs, "FsCompetitionResults"), "FsCompetitionResult")
      .filter((r) => r.attrs.id === "overall")
      .at(-1)!;
    expect(overall.attrs.tasks).toBe("1;2;3;4;5");
    const ranking = competitionStandings(db, comp).ranking;
    const off: string[] = [];
    const fsPilots = children(overall, "FsParticipant");
    for (const p of fsPilots) {
      const ours = ranking.pilots.find((x) => x.pilot === p.attrs.id);
      if (!ours || Math.abs(ours.total - Number(p.attrs.points)) > OVERALL_TOLERANCE) off.push(`${p.attrs.id} : ${ours?.total.toFixed(1)} au lieu de ${p.attrs.points}`);
    }
    expect(off).toEqual([]);
    expect(ranking.pilots.slice(0, 10).map((p) => p.pilot)).toEqual(fsPilots.slice(0, 10).map((p) => p.attrs.id));
  });
});
