import { describe, expect, it } from "vitest";
import {
  distanceValidity,
  GAP_RULES,
  launchValidity,
  scoreGap,
  speedFraction,
  stoppedValidity,
  timeValidity,
  type GapPilotInput,
  type GapTaskInput,
} from "../src/gap.js";

const params = { nominalDistance: 50_000, minimumDistance: 3_000, nominalTime: 80 * 60 };
const hms = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;

describe("formules GAP (S7F 2026)", () => {
  it("part des points de temps : tableau 2 du S7F (12.2.1)", () => {
    for (const best of [1, 2, 3]) {
      const b = best * 3600;
      const t80 = { 1: hms(1, 8, 42), 2: hms(2, 12, 18), 3: hms(3, 15, 4) }[best]!;
      const t50 = { 1: hms(1, 26, 7), 2: hms(2, 36, 56), 3: hms(3, 45, 14) }[best]!;
      expect(speedFraction(t80, b)).toBeCloseTo(0.8, 3);
      expect(speedFraction(t50, b)).toBeCloseTo(0.5, 3);
      expect(speedFraction(b + Math.sqrt(best) * 3600, b)).toBeCloseTo(0, 9);
      expect(speedFraction(b, b)).toBe(1);
    }
  });

  it("validité de décollage (10.1)", () => {
    expect(launchValidity(96, 100)).toBe(1);
    expect(launchValidity(100, 100)).toBe(1);
    const lvr = 48 / 96;
    expect(launchValidity(48, 100)).toBeCloseTo(0.028 * lvr + 2.917 * lvr ** 2 - 1.944 * lvr ** 3, 12);
    expect(launchValidity(0, 100)).toBe(0);
  });

  it("validité de distance (10.2)", () => {
    // Aire nominale : (1,3 × 47 km + 0) / 2 = 30,55 km ; somme au-delà de la distance minimale : 2 × 27 km.
    expect(distanceValidity([30_000, 30_000], 3_000, 50_000, 30_000)).toBeCloseTo(27 / 30.55, 10);
    expect(distanceValidity([80_000, 80_000], 3_000, 50_000, 80_000)).toBe(1);
  });

  it("validité de temps (10.3)", () => {
    expect(timeValidity(1)).toBe(1);
    expect(timeValidity(2)).toBe(1);
    expect(timeValidity(0.05)).toBe(0);
    expect(timeValidity(0.5)).toBeCloseTo(-0.271 + 2.912 * 0.5 - 2.098 * 0.25 + 0.457 * 0.125, 12);
  });

  it("validité d'arrêt (13.4.3)", () => {
    expect(stoppedValidity({ pilotsEss: 1, flown: [1, 2], launchToEss: 80_000, flyingAtStop: 2, launched: 2 })).toBe(1);
    // Tout le monde posé : la validité de vol vaut 1.
    expect(stoppedValidity({ pilotsEss: 0, flown: [10_000, 20_000], launchToEss: 80_000, flyingAtStop: 0, launched: 2 })).toBe(1);
    const v = stoppedValidity({ pilotsEss: 0, flown: [10_000, 20_000, 30_000], launchToEss: 80_000, flyingAtStop: 3, launched: 3 });
    const stdev = Math.sqrt(((10 - 20) ** 2 + 0 + (30 - 20) ** 2) / 3);
    expect(v).toBeCloseTo(Math.sqrt(((30 - 20) / (80 - 30 + 1)) * Math.sqrt(stdev / 5)), 12);
  });
});

const pilot = (id: string, p: Partial<GapPilotInput>): GapPilotInput => ({
  id,
  flying: true,
  madeEss: false,
  madeGoal: false,
  distance: 3_000,
  flownDistance: 3_000,
  speedSectionTime: null,
  startTime: null,
  leadingFactor: null,
  ...p,
});

describe("répartition et points (11, 12)", () => {
  it("formule PWCA : Gemona 2026 manche 3 (106 au goal sur 123)", () => {
    const pilots = Array.from({ length: 123 }, (_, i) =>
      pilot(String(i), i < 106 ? { madeEss: true, madeGoal: true, distance: 84_030, flownDistance: 84_030, speedSectionTime: 7000 } : { distance: 60_000, flownDistance: 60_000 }),
    );
    const r = scoreGap({ params: { ...params, nominalDistance: 60_000, nominalTime: 3600 }, rules: GAP_RULES.PWCA, launchToEss: 81_530, pilots });
    expect(r.available).toEqual({ distance: 353.2, time: 476.6, leading: 170.2, arrival: 0 });
  });

  it("formule S7F : points disponibles arrondis à l'unité, LTR 26 %", () => {
    const pilots = [
      pilot("a", { madeEss: true, madeGoal: true, distance: 70_000, flownDistance: 70_000, speedSectionTime: 6000, leadingFactor: 1 }),
      pilot("b", { distance: 35_000, flownDistance: 35_000, leadingFactor: 0.5 }),
    ];
    const r = scoreGap({ params, rules: GAP_RULES.S7F2026, launchToEss: 68_000, pilots });
    const dw = 0.9 - 1.665 * 0.5 + 1.713 * 0.25 - 0.587 * 0.125;
    expect(r.goalRatio).toBe(0.5);
    expect(r.available.distance).toBe(Math.round(1000 * r.validity.task * dw));
    expect(r.available.leading).toBe(Math.round(1000 * r.validity.task * (1 - dw) * 0.26));
    const a = r.pilots[0]!;
    const b = r.pilots[1]!;
    expect(a.points.time).toBe(r.available.time);
    expect(b.points.distance).toBeCloseTo(r.available.distance / 2, 1);
    expect(b.points.leading).toBeCloseTo(r.available.leading / 2, 1);
  });

  it("sans pilote au goal, le reste va au leading, et pas de points de temps", () => {
    const r = scoreGap({
      params,
      rules: GAP_RULES.S7F2026,
      launchToEss: 68_000,
      pilots: [pilot("a", { distance: 40_000, flownDistance: 40_000, leadingFactor: 1 })],
    });
    expect(r.weights.distance).toBeCloseTo(0.9, 12);
    expect(r.weights.leading).toBeCloseTo(0.1, 12);
    expect(r.available.time).toBe(0);
    expect(r.pilots[0]!.points.time).toBe(0);
  });

  it("ESS sans goal : pas de points de temps (13.2) ; le meilleur temps vient du goal en S7F", () => {
    const pilots = [
      pilot("goal", { madeEss: true, madeGoal: true, distance: 70_000, flownDistance: 70_000, speedSectionTime: 7200 }),
      pilot("ess", { madeEss: true, distance: 69_000, flownDistance: 69_000, speedSectionTime: 6000 }),
    ];
    const s7f = scoreGap({ params, rules: GAP_RULES.S7F2026, launchToEss: 68_000, pilots });
    expect(s7f.bestTime).toBe(7200);
    expect(s7f.pilots[0]!.points.time).toBe(s7f.available.time);
    expect(s7f.pilots[1]!.points.time).toBe(0);
    // PWCA : meilleur temps pris sur tous les pilotes à l'ESS.
    expect(scoreGap({ params, rules: GAP_RULES.PWCA, launchToEss: 68_000, pilots }).bestTime).toBe(6000);
  });

  it("pénalités : pourcentage, puis points ; jamais sous zéro (13.5)", () => {
    const pilots = [
      pilot("a", { madeEss: true, madeGoal: true, distance: 70_000, flownDistance: 70_000, speedSectionTime: 6000, penalty: { fraction: 0.1 } }),
      pilot("b", { distance: 40_000, flownDistance: 40_000, penalty: { points: 1000 } }),
      pilot("c", { distance: 40_000, flownDistance: 40_000, penalty: { points: -20 } }),
    ];
    const r = scoreGap({ params, rules: GAP_RULES.S7F2026, launchToEss: 68_000, pilots });
    const [a, b, c] = r.pilots;
    expect(a!.total).toBeCloseTo(a!.score * 0.9, 1);
    expect(b!.total).toBe(0);
    expect(c!.total).toBeCloseTo(c!.score + 20, 1);
  });

  it("validité de décollage avec des pilotes présents non partis", () => {
    const pilots = [pilot("a", { distance: 40_000, flownDistance: 40_000 })];
    const r = scoreGap({ params, rules: GAP_RULES.S7F2026, launchToEss: 68_000, pilotsPresent: 4, pilots });
    expect(r.validity.launch).toBeCloseTo(launchValidity(1, 4), 12);
  });

  it("manche arrêtée avec des pilotes au goal : réduction des points de temps reversée en distance (13.4.5)", () => {
    const gate = Date.UTC(2026, 6, 1, 12);
    const input: GapTaskInput = {
      params,
      rules: GAP_RULES.S7F2026,
      launchToEss: 68_000,
      stopped: { stopTime: gate + 3 * 3600_000, singleGateRace: true, firstStartGate: gate },
      pilots: [
        pilot("goal", { madeEss: true, madeGoal: true, distance: 70_000, flownDistance: 70_000, speedSectionTime: 7200, startTime: gate }),
        pilot("ess", { madeEss: true, distance: 69_000, flownDistance: 69_000, speedSectionTime: 8000, startTime: gate }),
        pilot("df", { distance: 50_000, flownDistance: 50_000, startTime: gate }),
      ],
    };
    const r = scoreGap(input);
    const plain = scoreGap({ ...input, stopped: null });
    // Pilote de référence : celui entre ESS et goal, avec son temps à l'ESS (8000 s).
    const reduction = Math.round(speedFraction(8000, 7200) * r.available.time * 10) / 10;
    expect(r.timePointsReduction).toBe(reduction);
    expect(r.pilots[0]!.points.time).toBeCloseTo(r.available.time - reduction, 1);
    expect(r.available.distance).toBeCloseTo(plain.available.distance * (r.validity.task / plain.validity.task) + reduction, 0);
  });
});
