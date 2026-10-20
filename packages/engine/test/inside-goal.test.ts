import { describe, expect, it } from "vitest";
import { controlFlight, direct, parseXctsk, taskDistances, type IgcFix, type Task } from "../src/index.js";

// Manches réelles du calendrier CIVL : goal de 40 km autour du décollage (on sort du cylindre), et
// manches saisies sans SSS.
describe("goal autour du décollage", () => {
  const to = { name: "TO", lat: 52.5, lon: -2.9 };
  const task: Task = {
    type: "race",
    startGates: ["12:00:00"],
    turnpoints: [
      { role: "takeoff", zone: { kind: "cylinder", waypoint: to, radius: 400 } },
      { role: "sss", zone: { kind: "cylinder", waypoint: to, radius: 2000 } },
      { role: "goal", zone: { kind: "cylinder", waypoint: to, radius: 40000 } },
    ],
  };

  it("distance de la manche : jusqu'au bord du goal, en sortant", () => {
    const d = taskDistances(task);
    expect(d.task).toBeCloseTo(40000, -1);
    expect(d.speedSection).toBeCloseTo(38000, -1);
  });

  it("un pilote posé à 15 km du centre a fait 15 km", () => {
    const t0 = Date.UTC(2026, 5, 1, 12, 5, 0);
    const fixes: IgcFix[] = [];
    for (let m = 0; m <= 15000; m += 50) {
      const p = direct(to, 45, m);
      fixes.push({ time: t0 + fixes.length * 5000, lat: p.lat, lon: p.lon, valid: true, pressureAltitude: 1000, gnssAltitude: 1000 });
    }
    expect(controlFlight(task, fixes).flownDistance).toBeCloseTo(15000, -2);
  });
});

describe("manche sans SSS", () => {
  const wp = (name: string, lat: number) => ({ name, lat, lon: 13.5 });
  it("prend la première balise après le décollage comme départ", () => {
    const t = parseXctsk(
      JSON.stringify({
        taskType: "CLASSIC",
        sss: { type: "RACE" },
        goal: { type: "CYLINDER" },
        turnpoints: [
          { type: "TAKEOFF", radius: 400, waypoint: wp("TO", 50.4) },
          { radius: 19000, waypoint: wp("A", 50.47) },
          { type: "ESS", radius: 1500, waypoint: wp("B", 50.29) },
          { radius: 1000, waypoint: wp("B", 50.29) },
        ],
      }),
    );
    expect(t.turnpoints.map((x) => x.role)).toEqual(["takeoff", "sss", "ess", "goal"]);
  });

  it("à défaut, le cylindre du décollage", () => {
    const t = parseXctsk(
      JSON.stringify({
        taskType: "CLASSIC",
        sss: { type: "RACE" },
        goal: { type: "CYLINDER" },
        turnpoints: [
          { type: "TAKEOFF", radius: 3000, waypoint: wp("TO", 50.4) },
          { type: "ESS", radius: 2000, waypoint: wp("B", 50.0) },
          { radius: 1000, waypoint: wp("B", 50.0) },
        ],
      }),
    );
    expect(t.turnpoints.map((x) => x.role)).toEqual(["sss", "ess", "goal"]);
  });
});
