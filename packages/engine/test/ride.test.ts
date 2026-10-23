import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { competitionParameters, finishScoring, parseXctsk, rideSamples, sharedRides, type ControlledPilot, type IgcFix, type PilotResult } from "../src/index.js";

const task = parseXctsk(readFileSync(new URL("./fixtures/pwca-baixo-guandu-2026-t1.qr.txt", import.meta.url), "utf8").trim());
const params = competitionParameters({ minimumDistance: 3000, nominalDistance: 50_000, nominalTime: 4800 });

/** Trajet d'une seconde à l'autre, décalé de `north` mètres vers le nord, avec un bruit de ± `jitter` m. */
function path(seconds: number, north: number, jitter = 0, start = Date.UTC(2024, 7, 18, 11, 42, 17)): IgcFix[] {
  const out: IgcFix[] = [];
  for (let s = 0; s <= seconds; s++) {
    const noise = jitter * Math.sin(s * 1.7 + north);
    out.push({
      time: start + s * 1000,
      lat: 40.3133 + (north + noise) / 111_195 - (s * 6) / 111_195,
      lon: 21.5305 - (s * 3) / 85_000,
      valid: true,
      pressureAltitude: 1200 - s,
      gnssAltitude: 1200 - s,
    });
  }
  return out;
}

function pilot(id: string, fixes: IgcFix[]): ControlledPilot {
  const result: PilotResult = {
    id, name: id, status: "MIND", startTime: null, essTime: null, goalTime: null, speedSectionTime: null, flownDistance: 700, distance: 3000,
    stop: null, leadingCoefficient: null, leadingFactor: null, airspace: [], airspacePenalty: null, approaches: [], points: null, score: null,
    penaltyPoints: null, total: null, fixes: fixes.length, warnings: 0,
  };
  return { result, control: null, leading: null, ride: rideSamples(fixes) };
}

describe("trajets en véhicule (navette)", () => {
  it("des traces collées pendant tout le trajet ne sont pas des vols (Siatista 2024, manche 1)", () => {
    // Trois traqueurs dans la même navette (à 2 à 6 m), deux pilotes en gaggle à 140 m l'un de l'autre.
    const r = finishScoring(task, [pilot("a", path(600, 0, 3)), pilot("b", path(600, 4, 3)), pilot("c", path(600, -3, 3)), pilot("d", path(600, 300)), pilot("e", path(600, 440))], { params });
    const by = (id: string) => r.pilots.find((p) => p.id === id)!;
    for (const id of ["a", "b", "c"]) {
      expect(by(id).status).toBe("DNF");
      expect(by(id).distance).toBe(0);
    }
    expect(by("a").sharedRide).toEqual(["b", "c"]);
    expect(by("d").status).toBe("MIND");
    expect(by("d").sharedRide).toBeUndefined();
    // Les DNF comptent parmi les présents, pas parmi les volants.
    expect(r.gap.pilotsFlying).toBe(2);
  });

  it("un trajet commun trop court ou une petite partie du vol ne suffit pas", () => {
    const short = sharedRides([rideSamples(path(120, 0)), rideSamples(path(120, 2))], ["a", "b"]);
    expect(short).toEqual([[], []]);
    // Même départ, puis l'un continue seul une heure : 10 min collées sur 70 ne font pas une navette pour lui.
    const long = path(4200, 0);
    const res = sharedRides([rideSamples(long), rideSamples(path(600, 2))], ["a", "b"]);
    expect(res[0]).toEqual([]);
    expect(res[1]).toEqual([0]);
  });

  it("deux traces d'un même pilote ne sont pas comparées", () => {
    expect(sharedRides([rideSamples(path(600, 0)), rideSamples(path(600, 1))], ["a", "a"])).toEqual([[], []]);
  });
});
