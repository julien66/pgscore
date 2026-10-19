import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseXctsk, taskDistances } from "../src/index.js";

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
