import { describe, expect, it } from "vitest";
import { encodePolylineInts, decodePolylineInts, parseXctsk } from "../src/xctsk.js";

// Manche 1 de la PWC Baixo Guandu 2026 (balises relevées sur scoring.pwca.org).
const pwcaT1 = {
  taskType: "CLASSIC",
  version: 1,
  earthModel: "WGS84",
  turnpoints: [
    { type: "TAKEOFF", radius: 400, waypoint: { name: "TOFF", lat: -19.63129, lon: -40.96808 } },
    { type: "SSS", radius: 3000, waypoint: { name: "SSS", lat: -19.63129, lon: -40.96808 } },
    { radius: 6500, waypoint: { name: "TP1", lat: -19.59559, lon: -40.81499 } },
    { radius: 12000, waypoint: { name: "TP2", lat: -19.35879, lon: -41.37993 } },
    { type: "ESS", radius: 2000, waypoint: { name: "ESS", lat: -19.56532, lon: -41.21686 } },
    { radius: 100, waypoint: { name: "GOAL", lat: -19.56532, lon: -41.21686 } },
  ],
  takeoff: { timeOpen: "12:00:00Z", timeClose: "20:00:00Z" },
  sss: { type: "RACE", direction: "EXIT", timeGates: ["15:45:00Z"] },
  goal: { type: "CYLINDER", deadline: "20:00:00Z" },
};

describe("lecture .xctsk", () => {
  it("lit un fichier version 1", () => {
    const task = parseXctsk(JSON.stringify(pwcaT1));
    expect(task.type).toBe("race");
    expect(task.turnpoints.map((t) => t.role)).toEqual(["takeoff", "sss", "turnpoint", "turnpoint", "ess", "goal"]);
    expect(task.startGates).toEqual(["15:45:00"]);
    expect(task.deadline).toBe("20:00:00");
    const tp2 = task.turnpoints[3]!.zone;
    expect(tp2.kind).toBe("cylinder");
    if (tp2.kind === "cylinder") expect(tp2.radius).toBe(12000);
  });

  it("refuse une manche sans départ", () => {
    const noSss = { ...pwcaT1, turnpoints: pwcaT1.turnpoints.map((t) => ({ ...t, type: undefined })) };
    expect(() => parseXctsk(JSON.stringify(noSss))).toThrow(/départ/);
  });

  it("encode et décode les entiers polyline", () => {
    const values = [-4096808, -1963129, 512, 3000, 0, -1, 1];
    expect(decodePolylineInts(encodePolylineInts(values))).toEqual(values);
  });

  it("lit un QR code version 2", () => {
    const z = (lat: number, lon: number, alt: number, r: number) =>
      encodePolylineInts([Math.round(lon * 1e5), Math.round(lat * 1e5), alt, r]);
    const qr =
      "XCTSK:" +
      JSON.stringify({
        taskType: "CLASSIC",
        version: 2,
        t: [
          { z: z(-19.63129, -40.96808, 600, 3000), n: "SSS", t: 2 },
          { z: z(-19.59559, -40.81499, 100, 6500), n: "TP1" },
          { z: z(-19.56532, -41.21686, 90, 2000), n: "ESS", t: 3 },
          { z: z(-19.56532, -41.21686, 90, 100), n: "GOAL" },
        ],
        s: { g: ["15:45:00Z"], d: 2, t: 1 },
        g: { d: "20:00:00Z", t: 2 },
        e: 0,
      });
    const task = parseXctsk(qr);
    expect(task.turnpoints.map((t) => t.role)).toEqual(["sss", "turnpoint", "ess", "goal"]);
    expect(task.turnpoints[0]!.zone.waypoint.lat).toBeCloseTo(-19.63129, 5);
    expect(task.startDirection).toBe("exit");
  });
});
