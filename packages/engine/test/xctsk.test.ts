import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { encodePolylineInts, decodePolylineInts, parseXctsk, parseXctskQr, taskToXctskQr } from "../src/xctsk.js";

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

describe("QR code réel PWCA Baixo Guandu 2026, manche 1", () => {
  const text = readFileSync(new URL("./fixtures/pwca-baixo-guandu-2026-t1.qr.txt", import.meta.url), "utf8");
  const task = parseXctsk(text);

  it("retrouve les six balises et leurs rôles", () => {
    expect(task.turnpoints.map((t) => t.role)).toEqual(["takeoff", "sss", "turnpoint", "turnpoint", "ess", "goal"]);
    expect(task.turnpoints.map((t) => t.zone.waypoint.name)).toEqual(["D01088", "D01088", "B17061", "B27036", "G03016", "G03016"]);
  });

  it("retrouve rayons et coordonnées publiés par la PWCA", () => {
    const radii = task.turnpoints.map((t) => (t.zone.kind === "cylinder" ? t.zone.radius : t.zone.length / 2));
    expect(radii).toEqual([400, 3000, 6500, 12000, 2000, 100]);
    expect(task.turnpoints[3]!.zone.waypoint.lat).toBeCloseTo(-19.35879, 5);
    expect(task.turnpoints[3]!.zone.waypoint.lon).toBeCloseTo(-41.37993, 5);
  });

  it("lit le départ et le goal", () => {
    expect(task.type).toBe("race");
    expect(task.startGates).toEqual(["15:45:00"]);
    expect(task.deadline).toBe("20:00:00");
    expect(task.turnpoints[5]!.zone.kind).toBe("goal-line");
  });
});

describe("écriture du QR code XCTrack", () => {
  for (const f of ["pwca-baixo-guandu-2026-t1", "pwca-baixo-guandu-2026-t2", "pwca-feltre-2025-t3", "pwca-gemona-2026-t3"]) {
    it(`relit à l'identique la manche ${f}`, () => {
      const text = readFileSync(new URL(`fixtures/${f}.qr.txt`, import.meta.url), "utf8").trim();
      const task = parseXctskQr(text);
      const out = taskToXctskQr(task);
      expect(out.startsWith("XCTSK:")).toBe(true);
      expect(parseXctskQr(out)).toEqual(task);
    });
  }
  it("écrit une ligne de goal avec sa demi-longueur et un time trial", () => {
    const task = parseXctskQr(readFileSync(new URL("fixtures/pwca-baixo-guandu-2026-t1.qr.txt", import.meta.url), "utf8"));
    const tt = { ...task, type: "time-trial" as const };
    expect(parseXctskQr(taskToXctskQr(tt)).type).toBe("time-trial");
    expect(JSON.parse(taskToXctskQr(task).slice(6)).g.t).toBe(1);
  });
});
