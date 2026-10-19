import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  controlFlight,
  leadingCoefficient,
  leadingFactor,
  leadingTrack,
  parseIgc,
  parseXctsk,
  taskDistances,
  type LeadingTrack,
} from "../src/index.js";

// Les 49 traces ne sont pas dans le dépôt : PWCA_T1_IGC_DIR pointe vers le zip décompressé de la manche 1.
const dir = process.env.PWCA_T1_IGC_DIR;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe.skipIf(!dir || !existsSync(dir))("profil de leading PWCA, Baixo Guandu 2026 manche 1", () => {
  it("retrouve les points de leading publiés à 0,1 point près", { timeout: 600_000 }, () => {
    const task = parseXctsk(fixture("pwca-baixo-guandu-2026-t1.qr.txt").trim());
    const ss = taskDistances(task).speedSection / 1000;
    const rows = fixture("pwca-baixo-guandu-2026-t1-points.csv").trim().split("\n").slice(1).map((l) => l.split(","));
    const tracks = new Map<string, LeadingTrack | null>();
    for (const [id] of rows) {
      const file = readdirSync(dir!).find((f) => f === `${id}.igc` || f.endsWith(`.${id}.igc`))!;
      const c = controlFlight(task, parseIgc(readFileSync(`${dir}/${file}`, "latin1")).fixes);
      tracks.set(id!, leadingTrack(task, c));
    }
    // Fin de manche retenue par la PWCA : 19:17:24Z, soit 12 744 s après la porte (notre dernier posé : +22 s).
    const maxTime = 12_744;
    const lc = new Map([...tracks].filter(([, t]) => t).map(([id, t]) => [id, leadingCoefficient(t!, ss, maxTime, "PWCA")]));
    const lcMin = Math.min(...lc.values());
    expect(lcMin).toBeCloseTo(1.73356, 3); // « Best progress coefficient » publié
    for (const [id, , lead] of rows) {
      const l = lc.get(id!);
      const points = l === undefined ? 0 : Math.round(leadingFactor(l, lcMin, "PWCA") * 1636) / 10;
      expect(Math.abs(points - Number(lead || 0)), `pilote ${id}`).toBeLessThanOrEqual(0.11);
    }
  });
});
