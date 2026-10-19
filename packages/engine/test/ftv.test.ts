import { describe, expect, it } from "vitest";
import { competitionRanking } from "../src/ftv.js";

const task = (key: string, scores: Record<string, number>, stopped = false) => ({
  key,
  stopped,
  results: Object.entries(scores).map(([pilot, total]) => ({ pilot, name: `P${pilot}`, total })),
});

describe("classement général FTV", () => {
  it("additionne simplement sans FTV", () => {
    const r = competitionRanking([task("1", { a: 1000, b: 500 }), task("2", { a: 300, b: 800 })], 0);
    expect(r.pilots.map((p) => [p.pilot, p.total])).toEqual([["a", 1300], ["b", 1300]]);
    expect(r.pilots[0]!.rank).toBe(1);
    expect(r.pilots[1]!.rank).toBe(1);
  });

  it("ne garde que les meilleures performances jusqu'à la validité totale fixe", () => {
    // Validités 1, 0,8 et 0,5 : total fixe 0,75 × 2,3 = 1,725.
    const r = competitionRanking(
      [task("1", { w1: 1000, p: 900 }), task("2", { w2: 800, p: 400 }), task("3", { w3: 500, p: 450 })],
      0.25,
    );
    expect(r.fixedTotalValidity).toBeCloseTo(1.725, 9);
    const p = r.pilots.find((x) => x.pilot === "p")!;
    // 900 (perf 0,9, validité 1) + 450 (perf 0,9, validité 0,5) + 400 × 0,225 / 0,8.
    expect(p.total).toBe(1462.5);
    expect(p.sum).toBe(1750);
    expect(p.tasks["2"]!.fraction).toBeCloseTo(0.28125, 9);
    expect(p.tasks["1"]!.fraction).toBe(1);
    // Le vainqueur d'une seule manche garde tout : sa validité est sous le total fixe.
    expect(r.pilots.find((x) => x.pilot === "w1")!.total).toBe(1000);
  });

  it("retire une manche arrêtée de validité inférieure à 0,05", () => {
    const r = competitionRanking([task("1", { a: 1000 }), task("2", { a: 40, b: 30 }, true)], 0);
    expect(r.tasks[1]).toMatchObject({ included: false });
    expect(r.pilots.find((p) => p.pilot === "a")!.total).toBe(1000);
    expect(r.pilots.find((p) => p.pilot === "b")!.total).toBe(0);
  });
});
