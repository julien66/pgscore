import { describe, expect, it } from "vitest";
import { controlFlight, direct, type IgcFix, type Task } from "../src/index.js";

// Comme la distance de la manche, la distance d'un pilote posé se mesure jusqu'au bord du goal
// cylindre, pas jusqu'à son centre (écart de 400 m avec FS sur la manche 1 du French Open 2026).
describe("distance d'un pilote posé avant un goal cylindre", () => {
  const sss = { name: "SSS", lat: 45, lon: 6 };
  const goal = { name: "GOAL", lat: 45.1, lon: 6 };
  const task: Task = {
    type: "race",
    startGates: ["10:00:00"],
    turnpoints: [
      { role: "sss", zone: { kind: "cylinder", waypoint: sss, radius: 1000 } },
      { role: "goal", zone: { kind: "cylinder", waypoint: goal, radius: 400 } },
    ],
  };
  const t0 = Date.UTC(2026, 9, 6, 10, 5, 0);
  const fixes: IgcFix[] = [];
  // Plein nord à 10 m/s depuis le centre du départ, posé à 5 km du centre.
  for (let d = 0; d <= 5000; d += 10) {
    const p = direct(sss, 0, d);
    fixes.push({ time: t0 + fixes.length * 1000, lat: p.lat, lon: p.lon, valid: true, pressureAltitude: 1500, gnssAltitude: 1500 });
  }

  it("compte la distance depuis le bord du départ jusqu'au point de pose, goal au bord", () => {
    const c = controlFlight(task, fixes);
    expect(c.flownDistance).toBeCloseTo(4000, -1);
  });
});

// Manche arrêtée : le bonus d'altitude suit la finesse réglée dans la manche (FS : bonus_gr).
describe("bonus d'altitude d'une manche arrêtée", () => {
  const sss = { name: "SSS", lat: 45, lon: 6 };
  const goal = { name: "GOAL", lat: 45.5, lon: 6, altitude: 500 };
  const base: Task = {
    type: "race",
    startGates: ["10:00:00"],
    stopAnnouncement: "11:00:00",
    turnpoints: [
      { role: "sss", zone: { kind: "cylinder", waypoint: sss, radius: 1000 } },
      { role: "goal", zone: { kind: "cylinder", waypoint: goal, radius: 400 } },
    ],
  };
  const t0 = Date.UTC(2026, 9, 6, 10, 5, 0);
  // Plein nord à 5 m/s jusqu'à 11:00, à 1500 m (1000 m au-dessus du goal).
  const fixes: IgcFix[] = [];
  for (let s = 0; s <= 3600; s += 10) {
    const p = direct(sss, 0, 5 * s);
    fixes.push({ time: t0 + s * 1000, lat: p.lat, lon: p.lon, valid: true, pressureAltitude: 1500, gnssAltitude: 1500 });
  }

  it("finesse 2,5 par défaut, ou celle de la manche", () => {
    const byDefault = controlFlight(base, fixes).stopped!;
    const gr1 = controlFlight({ ...base, bonusGlideRatio: 1 }, fixes).stopped!;
    expect(byDefault.flyingAtStop).toBe(true);
    expect(byDefault.altitudeAboveGoal).toBeCloseTo(1000, 6);
    expect(byDefault.bonusDistance - gr1.bonusDistance).toBeCloseTo(1500, 3);
  });
});
