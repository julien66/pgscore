import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectFlights, parseIgc, type IgcFix } from "../src/index.js";

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

describe("posé, marche puis redécollage (US Open Chelan 2026, manche 1, pilote 3215)", () => {
  // Extrait de 23:30 à 23:52 UTC : posé à 23:35:35, marche à 1 m/s pendant 13 min, redécolle à 23:50. Pendant la
  // marche, l'altitude GNSS saute de 24 m en 40 s (23:38:21 → 23:39:01) quand le baromètre ne bouge pas : la
  // vitesse verticale de la marche se lit sur le baromètre, sinon le posé est daté de 23:39 et compte 185 m
  // de marche vers le goal (FS : 101,90 km).
  const fixes = parseIgc(readFileSync(new URL("./fixtures/us-open-chelan-2026-t1-repose.igc", import.meta.url), "utf8")).fixes;
  const hms = (i: number) => new Date(fixes[i]!.time).toISOString().slice(11, 19);

  it("le posé est daté du toucher, pas de la fin de la marche", () => {
    const [f, again] = detectFlights(fixes);
    expect(f!.landed).toBe(true);
    expect(hms(f!.landingIndex) >= "23:35:30" && hms(f!.landingIndex) <= "23:35:45", hms(f!.landingIndex)).toBe(true);
    expect(again, "redécollage").toBeTruthy();
    expect(hms(again!.takeoffIndex) >= "23:49:30", hms(again!.takeoffIndex)).toBe(true);
  });
});
