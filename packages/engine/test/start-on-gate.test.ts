import { describe, expect, it } from "vitest";
import { controlFlight, direct, type IgcFix, type Task } from "../src/index.js";

// S7F 2026, 9.2.3 et 9.2.4 : l'heure d'un passage est celle du fix qui le constate, et le départ est le
// premier passage strictement après la porte. Un premier fix hors du cylindre pile à l'heure de la porte
// constate une sortie qui a eu lieu avant elle (cas de Korey Curtis, US Open 2026, manche 1).
describe("départ pile à l'heure de la porte", () => {
  const to = { name: "TO", lat: 47.8, lon: -120.0 };
  const task = (gates: string[]): Task => ({
    type: "race",
    startGates: gates,
    turnpoints: [
      { role: "takeoff", zone: { kind: "cylinder", waypoint: to, radius: 0 } },
      { role: "sss", zone: { kind: "cylinder", waypoint: to, radius: 2000 } },
      { role: "goal", zone: { kind: "cylinder", waypoint: to, radius: 40000 } },
    ],
  });

  /** Vol en ligne droite à 20 m/s : dernier fix dedans à 1 990 m, premier fix dehors à 2 010 m, à `exit`. */
  const flight = (exit: number): IgcFix[] => {
    const fixes: IgcFix[] = [];
    const t0 = exit - 25_000;
    for (let k = 0; k <= 400; k++) {
      const p = direct(to, 90, 1510 + 20 * k);
      fixes.push({ time: t0 + k * 1000, lat: p.lat, lon: p.lon, valid: true, pressureAltitude: 1500, gnssAltitude: 1500 });
    }
    return fixes;
  };
  const gate = Date.UTC(2026, 5, 21, 20, 0, 0);

  it("sortie constatée à l'heure de la porte : pas de départ", () => {
    const c = controlFlight(task(["20:00:00"]), flight(gate));
    expect(c.sssTime).toBeNull();
    expect(c.startTime).toBeNull();
  });

  it("sortie constatée une seconde après la porte : départ", () => {
    const c = controlFlight(task(["20:00:00"]), flight(gate + 1000));
    expect(c.sssTime).toBe(gate + 1000);
    expect(c.startTime).toBe(gate);
  });

  it("plusieurs portes : sortie constatée pile à la deuxième, départ sur la première", () => {
    const second = gate + 30 * 60_000;
    const c = controlFlight(task(["20:00:00", "20:30:00"]), flight(second));
    expect(c.sssTime).toBe(second);
    expect(c.startTime).toBe(gate);
  });
});
