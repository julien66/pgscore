import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { competitionParameters, controlPilot, finishScoring, parseOpenAir, parseXctsk, type ScoringOptions } from "../src/index.js";

/**
 * Points GAP comparés aux résultats officiels PWCA (SVL, formule GAP_PWCA_2026), pilote par pilote.
 * Les traces sont hors dépôt : dossiers donnés par les variables d'environnement.
 */
const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

interface Case {
  name: string;
  dir: string | undefined;
  qr: string;
  points: string;
  stopAnnouncement?: string;
  options: Omit<ScoringOptions, "leadingProfile" | "gapProfile" | "airspacePenaltyRule">;
  /** Disponibles publiés : distance, temps, leading. */
  available: [number, number, number];
  /** Pilotes à écarter, avec la raison. */
  skip: Record<string, string>;
  /** Écart maximal sur le total, en points. */
  tolerance: number;
}

const cases: Case[] = [
  {
    name: "Gemona 2026, manche 3",
    dir: process.env.GEMONA_T3_IGC_DIR,
    qr: "pwca-gemona-2026-t3.qr.txt",
    points: "pwca-gemona-2026-t3-points.csv",
    options: {
      params: competitionParameters({ minimumDistance: 5000, nominalDistance: 60_000, nominalTime: 3600 }),
      airspaces: parseOpenAir(fixture("pwca-gemona-2026-airspace.txt")),
      roundAirspaceLimits: true,
      pilotsPresent: 123,
      taskEndTime: "14:53:53",
    },
    available: [353.2, 476.6, 170.2],
    skip: {
      "613": "bonus de 799 points saisi à la main par la PWCA",
      "260": "pénétration d'espace aérien de 3 m pour la PWCA, 4 m chez nous",
    },
    tolerance: 0.6,
  },
  {
    name: "Feltre 2025, manche 3 (arrêtée)",
    dir: process.env.FELTRE_T3_IGC_DIR,
    qr: "pwca-feltre-2025-t3.qr.txt",
    points: "pwca-feltre-2025-t3-points.csv",
    stopAnnouncement: "13:47:00",
    options: { params: competitionParameters({ minimumDistance: 5000, nominalDistance: 55_000, nominalTime: 5400 }), pilotsPresent: 118 },
    // Nos distances sont un peu plus longues (route PWCA avec cylindres agrandis de 0,1 %) : validité 0,4676 contre 0,4667.
    available: [420.8, 0, 46.8],
    skip: {},
    tolerance: 1,
  },
  {
    name: "Baixo Guandu 2026, manche 1",
    dir: process.env.PWCA_T1_IGC_DIR,
    qr: "pwca-baixo-guandu-2026-t1.qr.txt",
    points: "pwca-baixo-guandu-2026-t1-points.csv",
    options: { params: competitionParameters({ minimumDistance: 3000, nominalDistance: 50_000, nominalTime: 4800 }), pilotsPresent: 49, taskEndTime: "19:17:24" },
    available: [378.5, 457.9, 163.6],
    skip: {},
    tolerance: 0.5,
  },
];

for (const c of cases) {
  describe.skipIf(!c.dir || !existsSync(c.dir))(`points GAP PWCA : ${c.name}`, () => {
    const task = parseXctsk(fixture(c.qr).trim());
    if (c.stopAnnouncement) task.stopAnnouncement = c.stopAnnouncement;
    const options: ScoringOptions = { ...c.options, leadingProfile: "PWCA", gapProfile: "PWCA", airspacePenaltyRule: "pwca-soft" };
    const files = c.dir && existsSync(c.dir) ? readdirSync(c.dir).filter((f) => f.endsWith(".igc")) : [];
    const id = (f: string) => f.replace(/\.igc$/, "").replace(/^.*\./, "");
    const scoring = files.length
      ? finishScoring(task, files.map((f) => controlPilot(task, { id: id(f), igc: readFileSync(`${c.dir}/${f}`, "latin1") }, options)), options)
      : null;
    const [head, ...lines] = fixture(c.points).trim().split("\n");
    const cols = head!.split(",");
    const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));

    it("points disponibles", () => {
      const a = scoring!.gap.available;
      expect([a.distance, a.time, a.leading]).toEqual(c.available);
    });

    for (const row of rows) {
      if (row.status === "ABS" || c.skip[row.id!]) continue;
      it(`pilote ${row.id}`, () => {
        const p = scoring!.pilots.find((x) => x.id === row.id)!;
        expect(Math.abs(p.points!.time - Number(row.time))).toBeLessThanOrEqual(0.11);
        expect(Math.abs(p.points!.leading - Number(row.leading))).toBeLessThanOrEqual(c.tolerance);
        expect(Math.abs(p.total! - Number(row.total))).toBeLessThanOrEqual(c.tolerance);
      });
    }
  });
}
