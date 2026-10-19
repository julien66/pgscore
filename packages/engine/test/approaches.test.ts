import { describe, expect, it } from "vitest";
import { controlFlight, direct, zoneApproaches, type IgcFix, type Task } from "../src/index.js";

// Départ manqué : le pilote passe près du cylindre de départ sans y entrer (cas de Daniel, Baixo 2026 manche 2).
describe("passage au plus près des zones", () => {
  const sss = { name: "SSS", lat: 45, lon: 6 };
  const tp = { name: "B1", lat: 45.1, lon: 6 };
  const task: Task = {
    type: "race",
    startGates: ["10:00:00"],
    turnpoints: [
      { role: "sss", zone: { kind: "cylinder", waypoint: sss, radius: 1000 } },
      { role: "goal", zone: { kind: "cylinder", waypoint: tp, radius: 400 } },
    ],
  };
  const t0 = Date.UTC(2026, 9, 6, 10, 5, 0);
  const fixes: IgcFix[] = [];
  // Approche plein ouest à 10 m/s jusqu'à 1040 m du centre (40 m du bord), puis demi-tour.
  const path = [...Array(200).keys()].map((k) => 3030 - 10 * k);
  for (const d of [...path, ...path.slice(0, -1).reverse()]) {
    const p = direct(sss, 90, d);
    fixes.push({ time: t0 + fixes.length * 1000, lat: p.lat, lon: p.lon, valid: true, pressureAltitude: 1500, gnssAltitude: 1500 });
  }

  it("donne la distance au bord du départ non validé", () => {
    const c = controlFlight(task, fixes);
    const [start] = zoneApproaches(task, c);
    expect(start!.reached).toBe(false);
    expect(start!.closest!.distance).toBeCloseTo(40, 0);
    expect(start!.closest!.time).toBe(t0 + 199_000);
  });
});
