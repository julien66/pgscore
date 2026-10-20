import { describe, expect, it } from "vitest";
import { controlPilot, direct, finishScoringBest, type Task } from "../src/index.js";

// Deux traces pour un pilote : on garde celle qui lui rapporte le plus, quel que soit l'ordre d'envoi.
const sss = { name: "SSS", lat: 45, lon: 6 };
const goal = { name: "GOAL", lat: 45.3, lon: 6 };
const task: Task = {
  type: "race",
  startGates: ["10:00:00"],
  turnpoints: [
    { role: "sss", zone: { kind: "cylinder", waypoint: sss, radius: 1000 } },
    { role: "goal", zone: { kind: "cylinder", waypoint: goal, radius: 400 } },
  ],
};
const options = { params: { minimumDistance: 5000, nominalDistance: 30000, nominalTime: 3600 } };

/** Trace IGC synthétique : plein nord à 10 m/s depuis le centre du départ, sur `km` kilomètres. */
function igc(km: number): string {
  const ll = (v: number, deg: number) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    return String(d).padStart(deg, "0") + String(Math.round((a - d) * 60000)).padStart(5, "0");
  };
  const lines = ["AXXX synthétique", "HFDTE061026"];
  for (let s = 0; s <= km * 100; s += 5) {
    const p = direct(sss, 0, 10 * s);
    const t = 10 * 3600 + 5 * 60 + s;
    const hms = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((x) => String(x).padStart(2, "0")).join("");
    lines.push(`B${hms}${ll(p.lat, 2)}N${ll(p.lon, 3)}EA0150001500`);
  }
  return lines.join("\r\n") + "\r\n";
}

describe("plusieurs traces pour un pilote", () => {
  it("retient la trace la plus favorable au pilote", () => {
    const other = controlPilot(task, { id: "b", igc: igc(20) }, options);
    const short = controlPilot(task, { id: "a", igc: igc(10) }, options);
    const long = controlPilot(task, { id: "a", igc: igc(25) }, options);
    for (const order of [[short, long], [long, short]]) {
      const { scoring, chosen } = finishScoringBest(task, [order, [other]], options);
      expect(order[chosen[0]!]).toBe(long);
      const a = scoring.pilots.find((p) => p.id === "a")!;
      expect(a.distance).toBeGreaterThan(23_000);
      expect(scoring.pilots).toHaveLength(2);
    }
  });
});
