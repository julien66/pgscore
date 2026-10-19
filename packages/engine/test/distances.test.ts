import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseXctsk, taskDistances, type Task, type TaskTurnpoint } from "../src/index.js";

const qr = readFileSync(new URL("./fixtures/pwca-baixo-guandu-2026-t1.qr.txt", import.meta.url), "utf8").trim();

describe("distances de manche (S7F 7.1)", () => {
  it("retrouve les distances publiées par la PWCA (Baixo Guandu 2026, T1)", () => {
    const d = taskDistances(parseXctsk(qr));
    // Notre route est l'optimum WGS84 (vérifié par recherche directe sur l'ellipsoïde).
    expect(d.task).toBeCloseTo(74_798.3, 0);
    expect(d.launchToEss).toBeCloseTo(72_798.3, 0);
    expect(d.speedSection).toBeCloseTo(69_798.3, 0);
    // La PWCA publie 74,75 / 72,75 / 69,75 km : écart de 48 m, entièrement dans les
    // trois tronçons du milieu (pré-départ 3 000 m et ESS→goal 2 000 m identiques).
    for (const [ours, pwca] of [[d.task, 74_750], [d.launchToEss, 72_750], [d.speedSection, 69_750]] as const) {
      expect(Math.abs(ours - pwca) / pwca).toBeLessThan(0.001);
    }
  });
});

interface PwcaTask {
  task: number;
  pwca: { ss: number; ess: number; task: number };
  tps: Array<[TaskTurnpoint["role"], number, number, number]>;
}
const pwcaTasks: PwcaTask[] = JSON.parse(
  readFileSync(new URL("./fixtures/pwca-baixo-guandu-2026.json", import.meta.url), "utf8"),
);
const toTask = (t: PwcaTask): Task => ({
  type: "race",
  startGates: [],
  turnpoints: t.tps.map(([role, r, lat, lon]) => ({
    role,
    zone:
      role === "goal"
        ? { kind: "goal-line", waypoint: { name: "", lat, lon }, length: r * 2000 }
        : { kind: "cylinder", waypoint: { name: "", lat, lon }, radius: r * 1000 },
  })),
});

describe("six manches de Baixo Guandu 2026 comparées à la PWCA", () => {
  for (const t of pwcaTasks) {
    it(`manche ${t.task}`, () => {
      // S7F 2026 strict : toujours 40 à 110 m plus long que la PWCA.
      const strict = taskDistances(toTask(t));
      for (const [ours, pwca] of [[strict.task, t.pwca.task], [strict.launchToEss, t.pwca.ess], [strict.speedSection, t.pwca.ss]] as const) {
        expect(ours - pwca * 1000).toBeGreaterThan(40);
        expect(ours - pwca * 1000).toBeLessThan(110);
      }
      // Avec 0,1 % de tolérance relative, on retombe à ~10 m.
      const pwcaLike = taskDistances(toTask(t), { relativeTolerance: 0.001 });
      for (const [ours, pwca] of [[pwcaLike.task, t.pwca.task], [pwcaLike.launchToEss, t.pwca.ess], [pwcaLike.speedSection, t.pwca.ss]] as const) {
        expect(Math.abs(ours - pwca * 1000)).toBeLessThan(25);
      }
    });
  }
});
