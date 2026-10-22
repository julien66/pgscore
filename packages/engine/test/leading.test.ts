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

describe("leading GAP2025 (FS) : partie de vol manquante d'un pilote posé", () => {
  const track = (best: number): LeadingTrack => ({
    samples: [
      { t: 0, minToEss: 100 },
      { t: 3600, minToEss: best },
    ],
    quality: { fixes: 2, medianInterval: 1, maxGap: 0, maxGapAt: null, endsInFlight: false, warnings: [] },
    madeEss: false,
    essTime: null,
    outlandingTime: 3600,
  });
  const area = (best: number) => leadingCoefficient(track(best), 100, 0) * 1800;

  it("distance restante × poids à l'avancement atteint, au-delà du pic du poids", () => {
    const lc = leadingCoefficient(track(20), 100, 7200, "GAP2025");
    expect(lc * 1800 - area(20)).toBeCloseTo(7200 * 0.2 * leadingWeight(0.8), 6);
    // GAP2026 : intégrale, plus petite.
    expect(leadingCoefficient(track(20), 100, 7200)).toBeLessThan(lc);
  });

  it("avant le pic, le plus grand poids jusqu'à l'ESS", () => {
    const peak = Math.max(...Array.from({ length: 1001 }, (_, i) => leadingWeight(i / 1000)));
    const lc = leadingCoefficient(track(90), 100, 7200, "GAP2025");
    expect(lc * 1800 - area(90)).toBeCloseTo(7200 * 0.9 * peak, 1);
  });
});
