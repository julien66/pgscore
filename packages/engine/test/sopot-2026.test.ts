import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { competitionParameters, competitionRanking, controlPilot, finishScoring, parseXctsk, type ScoringOptions, type TaskScoring } from "../src/index.js";

/**
 * Compétition entière : PWC Sopot 2026 (Bulgarie), 4 manches dont une arrêtée, comparée aux résultats
 * officiels PWCA (SVL, formule GAP_PWCA_2026) manche par manche puis au classement général (FTV 25 %).
 * Pas de pénalité ni d'espace aérien publiés. Heures en UTC (Bulgarie : UTC+3).
 * Les traces sont hors dépôt : dossiers donnés par SOPOT_T1_IGC_DIR … SOPOT_T4_IGC_DIR
 * (scripts/fetch-test-tracks.sh).
 */
const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const params = competitionParameters({ minimumDistance: 5000, nominalDistance: 70_000, nominalTime: 75 * 60 });

const tasks: Array<{ n: number; options: Omit<ScoringOptions, "params" | "gapProfile" | "airspacePenaltyRule">; stopAnnouncement?: string; available: [number, number, number] }> = [
  { n: 1, options: { pilotsPresent: 69, taskEndTime: "14:54:41" }, available: [354.1, 476.0, 170.0] },
  // Arrêtée à 15:51 locale, score-back de 5 minutes.
  { n: 2, options: { pilotsPresent: 68 }, stopAnnouncement: "12:51:00", available: [900.0, 0, 100.0] },
  { n: 3, options: { pilotsPresent: 62, taskEndTime: "13:43:55" }, available: [366.1, 459.3, 164.0] },
  { n: 4, options: { pilotsPresent: 60, taskEndTime: "13:57:18" }, available: [390.6, 449.0, 160.4] },
];
const dirs = tasks.map((t) => process.env[`SOPOT_T${t.n}_IGC_DIR`]);
const ready = dirs.every((d) => d && existsSync(d));

/** Écart maximal sur le total d'un pilote, en points. */
const TOLERANCE = 0.5;

describe.skipIf(!ready)("PWC Sopot 2026 : manches et classement général", () => {
  const scored = new Map<number, TaskScoring>();
  const score = (k: number): TaskScoring => {
    const c = tasks[k]!;
    if (!scored.has(c.n)) {
      const task = parseXctsk(fixture(`pwca-sopot-2026-t${c.n}.qr.txt`).trim());
      if (c.stopAnnouncement) task.stopAnnouncement = c.stopAnnouncement;
      const options: ScoringOptions = { ...c.options, params, gapProfile: "PWCA", airspacePenaltyRule: "pwca-soft" };
      const dir = dirs[k]!;
      const files = readdirSync(dir).filter((f) => f.endsWith(".igc"));
      const pilots = files.map((f) => controlPilot(task, { id: f.replace(/\.igc$/, ""), igc: readFileSync(`${dir}/${f}`, "latin1") }, options));
      scored.set(c.n, finishScoring(task, pilots, options));
    }
    return scored.get(c.n)!;
  };

  tasks.forEach((c, k) => {
    describe(`manche ${c.n}`, () => {
      const [head, ...lines] = fixture(`pwca-sopot-2026-t${c.n}-points.csv`).trim().split("\n");
      const cols = head!.split(",");
      const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));

      it("points disponibles", { timeout: 120_000 }, () => {
        const a = score(k).gap.available;
        // SVL arrondit chaque part séparément : écart d'un dixième possible.
        [a.distance, a.time, a.leading].forEach((v, i) => expect(Math.abs(v - c.available[i]!)).toBeLessThanOrEqual(0.11));
      });

      it(`total de chaque pilote à ${TOLERANCE} point près`, { timeout: 120_000 }, () => {
        const s = score(k);
        const off: string[] = [];
        for (const row of rows) {
          if (row.status === "ABS") continue;
          const p = s.pilots.find((x) => x.id === row.id);
          if (!p) off.push(`${row.id} : absent`);
          else if (Math.abs(p.total! - Number(row.total)) > TOLERANCE) off.push(`${row.id} : ${p.total} au lieu de ${row.total}`);
        }
        expect(off).toEqual([]);
      });
    });
  });

  it("classement général FTV 25 %", { timeout: 300_000 }, () => {
    const lines = fixture("pwca-sopot-2026-overall.csv").trim().split("\n");
    const rows = lines.slice(1).map((l) => l.slice(1, -1).split('","'));
    const ranking = competitionRanking(
      tasks.map((c, k) => ({
        key: `T${c.n}`,
        stopped: Boolean(c.stopAnnouncement),
        results: score(k).pilots.map((p) => ({ pilot: p.id, name: p.name, total: p.total })),
      })),
      0.25,
    );
    const off: string[] = [];
    for (const r of rows) {
      const p = ranking.pilots.find((x) => x.pilot === r[1]);
      if (!p || Math.abs(p.total - Number(r[7])) > 1) off.push(`${r[2]} : ${p?.total.toFixed(1)} au lieu de ${r[7]}`);
    }
    expect(off).toEqual([]);
    expect(ranking.pilots.slice(0, 10).map((p) => p.pilot)).toEqual(rows.slice(0, 10).map((r) => r[1]));
  });
});
