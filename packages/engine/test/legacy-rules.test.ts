import { describe, expect, it } from "vitest";
import { controlFlight, leadingMaxTime, type IgcFix, type LeadingTrack, type Task } from "../src/index.js";

/**
 * Règles anciennes ou propres à un logiciel, retrouvées sur la German Open 2026 (résultats publiés par
 * civlcomps, apps/web/test/german-open-2026.test.ts) et gardées en option.
 */

describe("orientation du goal en ligne", () => {
  // À 60° de latitude, un degré de longitude vaut la moitié d'un degré de latitude : la direction du centre
  // précédent fait 45° en mètres, mais 26,6° en degrés bruts.
  const goal = { name: "GOAL", lat: 60, lon: 10 };
  const prev = { name: "SSS", lat: 60.01, lon: 10.02 };
  const task: Task = {
    type: "race",
    startGates: ["10:00:00"],
    turnpoints: [
      { role: "sss", zone: { kind: "cylinder", waypoint: prev, radius: 400 } },
      { role: "goal", zone: { kind: "goal-line", waypoint: goal, length: 400 } },
    ],
  };
  // Vol en ligne droite depuis le nord-est du départ jusqu'à 30 m à l'ouest et 40 m au nord du centre du goal :
  // 7 m avant la ligne orientée en mètres (au-delà des 5 m de tolérance), 9 m derrière celle orientée en degrés.
  const from = { lat: prev.lat + 0.002, lon: prev.lon + 0.004 };
  const to = { lat: goal.lat + 40 / 111_320, lon: goal.lon - 30 / (111_320 * 0.5) };
  const t0 = Date.UTC(2026, 9, 6, 10, 5, 0);
  const n = 200;
  const fixes: IgcFix[] = Array.from({ length: n + 1 }, (_, i) => ({
    time: t0 + i * 1000,
    lat: from.lat + ((to.lat - from.lat) * i) / n,
    lon: from.lon + ((to.lon - from.lon) * i) / n,
    valid: true,
    pressureAltitude: 1500,
    gnssAltitude: 1500,
  }));

  it("par défaut (S7F 2026, PWCA), la ligne est perpendiculaire à la route optimisée : pas de goal", () => {
    const c = controlFlight(task, fixes);
    expect(c.validated.map((v) => v.role)).toEqual(["sss"]);
    expect(c.madeGoal).toBe(false);
  });

  it("previousCentre (S7F 2024), perpendiculaire au centre précédent en degrés bruts : goal", () => {
    expect(controlFlight({ ...task, goalLineOrientation: "previousCentre" }, fixes).madeGoal).toBe(true);
  });
});

describe("fin des vols pour maxTime du leading", () => {
  const track = (essTime: number | null, outlandingTime: number | null): LeadingTrack => ({
    samples: [],
    madeEss: essTime !== null,
    essTime,
    outlandingTime,
  });

  it("lastLanding compte le posé le plus tardif", () => {
    expect(leadingMaxTime([track(5000, null), track(null, 7000)], Infinity, undefined, "lastLanding")).toBe(7000);
  });

  it("lastEss (par défaut, Flymaster) ne garde que la dernière arrivée à l'ESS", () => {
    expect(leadingMaxTime([track(5000, null), track(null, 7000)])).toBe(5000);
  });

  it("lastEss revient aux posés si personne n'arrive à l'ESS", () => {
    expect(leadingMaxTime([track(null, 6000), track(null, 7000)], Infinity, undefined, "lastEss")).toBe(7000);
  });
});
