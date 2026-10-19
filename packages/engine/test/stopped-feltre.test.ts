import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { controlFlight, parseIgc, parseXctsk } from "../src/index.js";

/** Traces de Feltre 2025 manche 3 (zip PWCA décompressé), hors dépôt. Manche arrêtée à 15:47 locale. */
const dir = process.env.FELTRE_T3_IGC_DIR;
const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

describe.skipIf(!dir || !existsSync(dir))("manche arrêtée PWCA Feltre 2025, manche 3", () => {
  const task = parseXctsk(fixture("pwca-feltre-2025-t3.qr.txt").trim());
  task.stopAnnouncement = "13:47:00";
  const rows = fixture("pwca-feltre-2025-t3-results.csv").trim().split("\n").slice(1).map((l) => l.split(","));
  for (const [id, dalt, dist] of rows) {
    it(`pilote ${id}`, () => {
      const f = readdirSync(dir!).find((f) => f === `${id}.igc` || f.endsWith(`.${id}.igc`))!;
      const c = controlFlight(task, parseIgc(readFileSync(`${dir}/${f}`, "latin1")).fixes);
      const s = c.stopped!;
      expect(s.taskStopTime).toBe(Date.UTC(2025, 6, 1, 13, 42));
      // Altitude au-dessus du goal à l'arrêt : identique au mètre près (502 se pose pile à 13:42, sous le goal).
      if (dalt && id !== "502") expect(Math.round(s.altitudeAboveGoal)).toBe(Number(dalt));
      if (!dalt) expect(s.flyingAtStop).toBe(false);
      // Distance avec bonus : PWCA plus courte de quelques dizaines de mètres, comme sur les autres manches.
      const d = Math.max(5000, s.scoredDistance) / 1000;
      expect(Math.abs(d - Number(dist))).toBeLessThan(0.08);
    });
  }
});
