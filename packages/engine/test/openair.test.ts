import { describe, expect, it } from "vitest";
import { distance } from "../src/geo.js";
import type { IgcFix } from "../src/igc.js";
import { airspaceInfringements, airspacePenalty, limitAmsl, parseAltitude, parseCoordinate, parseOpenAir } from "../src/openair.js";

const SAMPLE = `
* commentaire
AC D
AN CTR TEST
AL SFC
AH 1500m MSL
V X=46:00:00 N 013:00:00 E
DC 2
AC C
AN TMA TEST
AL FL95
AH FL195
DP 46:10:00 N 013:00:00 E
DP 46:10:00 N 013:10:00 E
DP 46:00:00 N 013:10:00 E
DP 46:00:00 N 013:00:00 E
AC R
AN ZONE AGL
AL SFC
AH 300 ft AGL
DP 45:00:00 N 012:00:00 E
DP 45:01:00 N 012:00:00 E
DP 45:01:00 N 012:01:00 E
`;

const fix = (lat: number, lon: number, alt: number, t: number): IgcFix => ({
  time: t * 1000, lat, lon, valid: true, pressureAltitude: alt, gnssAltitude: alt,
});

describe("OpenAir", () => {
  it("lit les altitudes", () => {
    expect(parseAltitude("SFC")).toEqual({ kind: "sfc" });
    expect(parseAltitude("GND")).toEqual({ kind: "sfc" });
    expect(parseAltitude("UNL")).toEqual({ kind: "unl" });
    expect(parseAltitude("FL 95")).toEqual({ kind: "fl", level: 95 });
    expect(parseAltitude("5000ft MSL")).toEqual({ kind: "amsl", meters: 1524 });
    expect(parseAltitude("1500 m")).toEqual({ kind: "amsl", meters: 1500 });
    expect(parseAltitude("1000 ft AGL").kind).toBe("agl");
    // FL95 = 9500 ft à 1013,25 hPa = 2895,6 m, abaissé de 100 m.
    expect(limitAmsl({ kind: "fl", level: 95 })).toBeCloseTo(2795.6, 1);
  });

  it("lit les coordonnées", () => {
    expect(parseCoordinate("46:16:30 N 013:10:48 E")).toEqual({ lat: 46.275, lon: 13.18 });
    const p = parseCoordinate("45:30.5S 012:15.25W");
    expect(p.lat).toBeCloseTo(-45.508333, 6);
    expect(p.lon).toBeCloseTo(-12.254167, 6);
  });

  it("lit les espaces, cercles compris", () => {
    const a = parseOpenAir(SAMPLE);
    expect(a.map((x) => x.name)).toEqual(["CTR TEST", "TMA TEST", "ZONE AGL"]);
    const centre = { lat: 46, lon: 13 };
    for (const p of a[0]!.polygon) expect(distance(centre, p)).toBeCloseTo(2 * 1852, 3);
    expect(a[1]!.polygon).toHaveLength(4);
  });

  it("détecte les infractions et leur profondeur", () => {
    const a = parseOpenAir(SAMPLE);
    const track = [
      fix(46.05, 13.05, 2700, 0), // sous le plancher de la TMA (2795,6 m)
      fix(46.05, 13.05, 2830, 10), // 34,4 m dedans
      fix(46.05, 13.05, 2700, 20),
      fix(46.0, 13.0, 1400, 30), // dans la CTR, 100 m sous le plafond
      fix(45.005, 12.005, 50, 40), // zone AGL : ignorée
    ];
    const inf = airspaceInfringements(a, track);
    expect(inf.map((i) => i.airspace.name)).toEqual(["TMA TEST", "CTR TEST"]);
    expect(inf[0]!.depth).toBeCloseTo(34.4, 1);
    expect(inf[0]!.from).toBe(10_000);
    expect(inf[1]!.depth).toBeCloseTo(100, 1);
  });
});

describe("pénalité d'espace aérien (règlement PWCA 2026)", () => {
  it("retrouve les pénalités publiées, formule soft (f = 100)", () => {
    // Gemona 2026 manche 3 : 18 m → −10,8 ; 83 m → −432 ; plus de 100 m → −1000.
    expect(airspacePenalty(18, 100)).toBeCloseTo(10.8, 1);
    expect(airspacePenalty(83, 100)).toBeCloseTo(432, 0);
    expect(airspacePenalty(146, 100)).toBe(1000);
    expect(airspacePenalty(50, 50)).toBe(1000);
    expect(airspacePenalty(0, 50)).toBe(0);
  });
});
