import { describe, expect, it } from "vitest";
import { detectFlights, type IgcFix } from "../src/index.js";

// Trace synthétique : vol vers l'est à 10 m/s, posé à t = 600 s, puis 3 min de marche à 1 m/s, puis immobile.
function track(): IgcFix[] {
  const fixes: IgcFix[] = [];
  const m = 1 / 111_320; // degrés de latitude par mètre
  let y = 0;
  for (let t = 0; t <= 1000; t++) {
    const flying = t < 600;
    const walking = t >= 600 && t < 780;
    y += flying ? 10 : walking ? 1 : 0;
    const alt = flying ? 1500 - t * 1.5 : 600;
    fixes.push({ time: t * 1000, lat: 45 + y * m, lon: 6, gnssAltitude: alt, pressureAltitude: alt, valid: true } as IgcFix);
  }
  return fixes;
}

describe("atterrissage suivi d'une marche", () => {
  it("l'atterrissage est au posé, pas à la fin de la marche", () => {
    const [f] = detectFlights(track());
    expect(f!.landed).toBe(true);
    expect(f!.landingIndex).toBeGreaterThanOrEqual(595);
    expect(f!.landingIndex).toBeLessThanOrEqual(625);
  });
});
