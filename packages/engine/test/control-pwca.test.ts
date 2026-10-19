import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { controlFlight, parseIgc, parseXctsk } from "../src/index.js";

// Les 49 traces (7,5 Mo) ne sont pas dans le dépôt : PWCA_T1_IGC_DIR pointe vers le zip décompressé.
const dir = process.env.PWCA_T1_IGC_DIR;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe.skipIf(!dir || !existsSync(dir))("contrôle des 49 traces PWCA Baixo Guandu 2026, manche 1", () => {
  const task = parseXctsk(fixture("pwca-baixo-guandu-2026-t1.qr.txt").trim());
  const rows = fixture("pwca-baixo-guandu-2026-t1-results.csv").trim().split("\n").slice(1).map((l) => l.split(","));
  // Heures PWCA en heure locale (UTC-3).
  const local = (ms: number | null) => (ms === null ? "" : new Date(ms - 3 * 3600e3).toISOString().slice(11, 19));

  for (const [id, , start, ess, dist, status] of rows) {
    it(`pilote ${id}`, () => {
      const file = readdirSync(dir!).find((f) => f === `${id}.igc` || f.endsWith(`.${id}.igc`))!;
      const c = controlFlight(task, parseIgc(readFileSync(`${dir}/${file}`, "latin1")).fixes);
      expect(c.madeGoal ? "GOAL" : c.madeEss ? "ESS" : "DF").toBe(status);
      expect(local(c.sssTime)).toBe(start);
      expect(local(c.essTime)).toBe(ess);
      // Distances : écart connu de 0 à 50 m dû au calcul de route de la PWCA.
      expect(Math.abs(c.flownDistance - Number(dist) * 1000)).toBeLessThan(60);
    });
  }
});
