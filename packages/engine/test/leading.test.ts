import { describe, expect, it } from "vitest";
import { leadingCoefficient, leadingFactor, leadingQuality, leadingWeight, type LeadingTrack } from "../src/index.js";

describe("points de leading (S7F 2026, 12.3)", () => {
  it("la pondération parapente est nulle aux extrémités et proche de 1 vers 30 %", () => {
    expect(leadingWeight(0)).toBe(0);
    expect(leadingWeight(1)).toBeCloseTo(0, 12);
    expect(leadingWeight(0.3)).toBeGreaterThan(0.95);
    expect(leadingWeight(0.3)).toBeLessThan(1);
  });

  it("LeadingFactor vaut 1 pour le meilleur et 0 à 2 × LCmin quand LCmin = 1 (figure 16)", () => {
    expect(leadingFactor(1.5, 1.5)).toBe(1);
    expect(leadingFactor(2, 1)).toBeCloseTo(0, 12);
    expect(leadingFactor(1.5, 1)).toBeCloseTo(1 - Math.cbrt(0.25), 12);
  });

  // Pilote qui avance à vitesse constante depuis t0 jusqu'à l'ESS (50 km).
  const linear = (t0: number, duration: number): LeadingTrack => {
    const samples = [];
    for (let s = 0; s <= duration; s += 10) samples.push({ t: t0 + s, minToEss: 50 * (1 - s / duration) });
    return { samples, madeEss: true, essTime: t0 + duration, outlandingTime: null };
  };

  it("partir tôt ou voler vite donne un LC plus petit", () => {
    const early = leadingCoefficient(linear(0, 7200), 50, 9000);
    const late = leadingCoefficient(linear(600, 7200), 50, 9000);
    const fast = leadingCoefficient(linear(0, 6000), 50, 9000);
    expect(early).toBeLessThan(late);
    expect(fast).toBeLessThan(early);
  });

  it("un pilote posé paie l'aire manquante jusqu'à maxTime", () => {
    const full = linear(0, 7200);
    const landed: LeadingTrack = {
      samples: full.samples.filter((s) => s.t <= 3600),
      madeEss: false,
      essTime: null,
      outlandingTime: 3600,
    };
    expect(leadingCoefficient(landed, 50, 9000)).toBeGreaterThan(leadingCoefficient(full, 50, 9000));
  });
});

describe("régularité de la trace pour le leading", () => {
  const t0 = Date.UTC(2026, 9, 5, 15, 0, 0);
  const every = (step: number, n: number, from = t0) => Array.from({ length: n }, (_, i) => from + i * step * 1000);

  it("ne signale rien pour une trace à 1 s", () => {
    expect(leadingQuality(every(1, 3600), false).warnings).toEqual([]);
  });

  it("signale une trace espacée, un trou et un arrêt avant l'atterrissage", () => {
    expect(leadingQuality(every(10, 300), false).warnings).toEqual([{ kind: "sparse", seconds: 10 }]);
    const holed = [...every(1, 600), ...every(1, 600, t0 + 600_000 + 90 * 60_000)];
    const q = leadingQuality(holed, true);
    expect(q.maxGap).toBe(5401);
    expect(q.maxGapAt).toBe(t0 + 599_000);
    expect(q.warnings).toEqual([{ kind: "gap", seconds: 5401 }, { kind: "ends-in-flight" }]);
  });
});
