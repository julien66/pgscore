import { describe, expect, it } from "vitest";
import { goalAltitudeFactor } from "../src/gap.js";

describe("elevated goal (S7F 2026, 13.1)", () => {
  it("facteur des points de temps selon l'altitude de passage", () => {
    expect(goalAltitudeFactor(100, 157, 300)).toBe(0.8);
    expect(goalAltitudeFactor(157, 157, 300)).toBe(0.8);
    expect(goalAltitudeFactor(457, 157, 300)).toBe(1);
    expect(goalAltitudeFactor(900, 157, 300)).toBe(1);
    // Mi-hauteur : AR = 0,5 → 0,8 + 0,3 − 0,15 + 0,025.
    expect(goalAltitudeFactor(307, 157, 300)).toBeCloseTo(0.975, 9);
    // German Open 2026, manche 4 (élévation 200 m) : Hans Petit passe à 292 m (AR = 0,675).
    expect(goalAltitudeFactor(292, 157, 200)).toBeCloseTo(0.9931, 4);
    expect(goalAltitudeFactor(200, 157, 0)).toBe(1);
  });
});
