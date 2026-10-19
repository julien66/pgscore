import { describe, expect, it } from "vitest";
import { competitionParameters, DEFAULT_COMPETITION_PARAMETERS, scoredDistance } from "../src/params.js";

describe("paramètres de compétition", () => {
  it("prend les valeurs par défaut et les remplace par celles de l'organisateur", () => {
    expect(competitionParameters()).toEqual(DEFAULT_COMPETITION_PARAMETERS);
    const pwca = competitionParameters({ minimumDistance: 3000 });
    expect(pwca.minimumDistance).toBe(3000);
    expect(pwca.nominalDistance).toBe(DEFAULT_COMPETITION_PARAMETERS.nominalDistance);
  });

  it("refuse des valeurs incohérentes", () => {
    expect(() => competitionParameters({ minimumDistance: -1 })).toThrow();
    expect(() => competitionParameters({ nominalDistance: 2000, minimumDistance: 3000 })).toThrow();
    expect(() => competitionParameters({ ftvFactor: 1.5 })).toThrow();
  });
});

describe("distance minimale (9.3)", () => {
  const params = competitionParameters({ minimumDistance: 3000 });
  it("ramène à la distance minimale (PWCA 2026 manche 2, pilote 2111 : 2,47 km → 3,00 km MIND)", () => {
    expect(scoredDistance(2470, params)).toEqual({ distance: 3000, minimumDistance: true });
  });
  it("garde la distance volée au-delà", () => {
    expect(scoredDistance(45_200, params)).toEqual({ distance: 45_200, minimumDistance: false });
  });
  it("accorde la distance minimale sans trace si le décollage est constaté", () => {
    expect(scoredDistance(null, params)).toEqual({ distance: 3000, minimumDistance: true });
  });
});
