import { describe, expect, it } from "vitest";
import {
  airspacePenalty,
  airspacePenaltyFractionS7A,
  controlFlight,
  direct,
  GAP_RULES,
  leadingCoefficient,
  leadingSpeedSectionKm,
  leadingWeight,
  scoreGap,
  scoreTask,
  taskDistances,
  writeIgc,
  type GapPilotInput,
  type GapProfile,
  type IgcFix,
  type Task,
} from "../src/index.js";

/**
 * Différences de calcul entre la formule CIVL (FS, profil « S7F2026 ») et la formule PWCA (SVL, profil « PWCA »).
 * Chaque bloc isole une différence sur un cas construit à la main, et porte l'identifiant (D1, D2…) repris par
 * la page publique /differences. Les tests sur compétitions réelles (Baixo Guandu, Sopot, Feltre…) montrent
 * ensuite que la différence suffit à retrouver les résultats publiés.
 */

const params = { minimumDistance: 5000, nominalDistance: 50_000, nominalTime: 5400 };
const sss = { name: "SSS", lat: 45, lon: 6 };
const fix = (time: number, p: { lat: number; lon: number }, alt = 1500): IgcFix => ({
  time,
  lat: p.lat,
  lon: p.lon,
  valid: true,
  pressureAltitude: alt,
  gnssAltitude: alt,
});
const pilot = (id: string, o: Partial<GapPilotInput>): GapPilotInput => ({
  id,
  flying: true,
  madeEss: false,
  madeGoal: false,
  distance: 20_000,
  flownDistance: 20_000,
  speedSectionTime: null,
  startTime: null,
  leadingFactor: null,
  ...o,
});
const both = <T>(f: (p: GapProfile) => T): { civl: T; pwca: T } => ({ civl: f("S7F2026"), pwca: f("PWCA") });

describe("D1 tolérance des cylindres : 5 m (CIVL) ou 0,1 % du rayon (PWCA)", () => {
  // Une balise de 60 km de rayon : 0,1 % = 60 m. Le pilote passe à 30 m du bord, puis repart vers le goal.
  const tp = direct(sss, 0, 80_000);
  const goal = direct(sss, 90, 30_000);
  const task: Task = {
    type: "race",
    startGates: ["10:00:00"],
    turnpoints: [
      { role: "sss", zone: { kind: "cylinder", waypoint: sss, radius: 1000 } },
      { role: "turnpoint", zone: { kind: "cylinder", waypoint: { name: "TP", ...tp }, radius: 60_000 } },
      { role: "goal", zone: { kind: "cylinder", waypoint: { name: "GOAL", ...goal }, radius: 400 } },
    ],
  };
  const t0 = Date.UTC(2026, 9, 6, 10, 0, 0);
  const fixes: IgcFix[] = [];
  // Plein nord jusqu'à 80 000 − 60 030 = 19 970 m du départ, puis demi-tour.
  for (let d = 0; d <= 19_970; d += 10) fixes.push(fix(t0 + fixes.length * 1000, direct(sss, 0, d)));
  for (let d = 19_970; d >= 0; d -= 10) fixes.push(fix(t0 + fixes.length * 1000, direct(sss, 0, d)));

  it("D1 un pilote à 30 m d'une balise de 60 km la valide en PWCA, pas en CIVL", () => {
    const civl = controlFlight({ ...task, cylinderTolerance: 0 }, fixes);
    const pwca = controlFlight({ ...task, cylinderTolerance: 0.001 }, fixes);
    expect(civl.validated.map((v) => v.role)).toEqual(["sss"]);
    expect(pwca.validated.map((v) => v.role)).toEqual(["sss", "turnpoint"]);
  });

  it("D1 la même tolérance raccourcit la distance de la manche", () => {
    const civl = taskDistances(task, { relativeTolerance: 0 }).task;
    const pwca = taskDistances(task, { relativeTolerance: 0.001 }).task;
    // La route touche la balise de 60 km agrandie de 60 m : environ 2 × 60 m de moins.
    expect(civl - pwca).toBeGreaterThan(60);
    expect(civl - pwca).toBeLessThan(130);
  });
});

describe("D2 poids de la distance : coefficients du S7F (CIVL) ou arrondis (PWCA)", () => {
  it("D2 les coefficients diffèrent et décalent le poids de la distance de moins d'un point de pourcentage", () => {
    expect(GAP_RULES.S7F2026.distanceWeight).toEqual({ d: 0.9, c: -1.665, b: 1.713, a: -0.587 });
    expect(GAP_RULES.PWCA.distanceWeight).toEqual({ d: 0.9, c: -1.67, b: 1.71, a: -0.59 });
    // 10 pilotes, 3 au goal (ratio 0,3), même vol pour tous les autres.
    const pilots = Array.from({ length: 10 }, (_, i) =>
      i < 3
        ? pilot(`g${i}`, { madeEss: true, madeGoal: true, distance: 60_000, flownDistance: 60_000, speedSectionTime: 5400 + i * 60, startTime: 0 })
        : pilot(`p${i}`, {}),
    );
    const w = both((p) => scoreGap({ params, rules: GAP_RULES[p], launchToEss: 60_000, pilots }).weights.distance);
    expect(w.civl).toBeCloseTo(0.9 - 1.665 * 0.3 + 1.713 * 0.09 - 0.587 * 0.027, 12);
    expect(w.pwca).toBeCloseTo(0.9 - 1.67 * 0.3 + 1.71 * 0.09 - 0.59 * 0.027, 12);
    expect(w.civl - w.pwca).toBeGreaterThan(0);
    expect(w.civl - w.pwca).toBeLessThan(0.01);
  });
});

describe("D3 Leading Time Ratio par défaut : 26 % (CIVL) ou 26,3158 % (PWCA)", () => {
  it("D3 sans LTR saisi pour la manche, chaque formule prend le sien", () => {
    const pilots = [pilot("a", { madeEss: true, madeGoal: true, distance: 60_000, flownDistance: 60_000, speedSectionTime: 5400, startTime: 0 }), pilot("b", {})];
    const ltr = both((p) => scoreGap({ params, rules: GAP_RULES[p], launchToEss: 60_000, pilots }).leadingTimeRatio);
    expect(ltr).toEqual({ civl: 0.26, pwca: 0.263158 });
  });
});

describe("D4 meilleur temps : pilotes au goal (CIVL) ou à l'ESS (PWCA)", () => {
  it("D4 un pilote plus rapide à l'ESS mais posé avant le goal donne le meilleur temps en PWCA seulement", () => {
    const pilots = [
      pilot("goal", { madeEss: true, madeGoal: true, distance: 60_000, flownDistance: 60_000, speedSectionTime: 3600, startTime: 0 }),
      pilot("ess", { madeEss: true, madeGoal: false, distance: 59_000, flownDistance: 59_000, speedSectionTime: 3000, startTime: 0 }),
      pilot("df", {}),
    ];
    const r = both((p) => scoreGap({ params, rules: GAP_RULES[p], launchToEss: 59_000, pilots }));
    expect(r.civl.bestTime).toBe(3600);
    expect(r.pwca.bestTime).toBe(3000);
    // Le pilote au goal a donc tous les points de temps en CIVL, une partie seulement en PWCA.
    const time = (s: typeof r.civl) => s.pilots.find((x) => x.id === "goal")!.points.time;
    expect(time(r.civl)).toBe(r.civl.available.time);
    expect(time(r.pwca)).toBeLessThan(r.pwca.available.time);
  });
});

describe("D5 taux de goal : tous les pilotes au goal (CIVL) ou ceux qui ont des points de temps (PWCA)", () => {
  it("D5 un pilote arrivé au goal trop tard pour marquer du temps ne compte pas dans le taux de goal PWCA", () => {
    // Meilleur temps 1 h : à 2 h ou plus, la part des points de temps est nulle (12.2).
    const pilots = Array.from({ length: 10 }, (_, i) =>
      i < 3
        ? pilot(`g${i}`, { madeEss: true, madeGoal: true, distance: 60_000, flownDistance: 60_000, speedSectionTime: [3600, 4000, 7500][i]!, startTime: 0 })
        : pilot(`p${i}`, {}),
    );
    const r = both((p) => scoreGap({ params, rules: GAP_RULES[p], launchToEss: 60_000, pilots }));
    expect(r.civl.goalRatio).toBeCloseTo(0.3, 12);
    expect(r.pwca.goalRatio).toBeCloseTo(0.2, 12);
    // Moins de pilotes au goal : plus de poids pour la distance en PWCA.
    expect(r.pwca.weights.distance).toBeGreaterThan(r.civl.weights.distance);
  });
});

describe("D6 leading : section de vitesse de la route complète (CIVL) ou la plus courte (PWCA)", () => {
  // Décollage 15 km à l'ouest d'un départ de 5 km de rayon, ESS 40 km à l'est. La route complète touche le départ
  // à l'ouest et le traverse : 44 km de section de vitesse. Depuis le bord est, la plus courte fait 34 km.
  const ess = { name: "ESS", ...direct(sss, 90, 40_000) };
  const task: Task = {
    type: "race",
    startGates: ["10:00:00"],
    turnpoints: [
      { role: "takeoff", zone: { kind: "cylinder", waypoint: { name: "TO", ...direct(sss, 270, 15_000) }, radius: 400 } },
      { role: "sss", zone: { kind: "cylinder", waypoint: sss, radius: 5000 } },
      { role: "ess", zone: { kind: "cylinder", waypoint: ess, radius: 1000 } },
      { role: "goal", zone: { kind: "cylinder", waypoint: ess, radius: 400 } },
    ],
  };

  it("D6 le LC se calcule sur 44 km en CIVL, 34 km en PWCA", () => {
    const km = both((p) => leadingSpeedSectionKm(task, p));
    expect(km.civl).toBeCloseTo(44, 2);
    expect(km.pwca).toBeCloseTo(34, 2);
    // Même trace : le LC dépend de cette distance (part parcourue de la section).
    const track = { samples: [{ t: 0, minToEss: 30 }, { t: 1800, minToEss: 15 }], madeEss: false, essTime: null, outlandingTime: 1800 };
    expect(leadingCoefficient(track, km.civl, 7200)).not.toBeCloseTo(leadingCoefficient(track, km.pwca, 7200), 2);
  });
});

describe("D7 manche arrêtée : fin du leading à l'heure d'arrêt (CIVL) ou à l'annonce (PWCA)", () => {
  // Arrêt annoncé à 11:00, score-back de 5 min : les vols comptent jusqu'à 10:55 dans les deux formules.
  const goal = direct(sss, 0, 100_000);
  const task: Task = {
    type: "race",
    startGates: ["10:00:00"],
    stopAnnouncement: "11:00:00",
    turnpoints: [
      { role: "sss", zone: { kind: "cylinder", waypoint: sss, radius: 1000 } },
      { role: "goal", zone: { kind: "cylinder", waypoint: { name: "GOAL", ...goal, altitude: 500 }, radius: 400 } },
    ],
  };
  const igc = (speed: number) => {
    const t0 = Date.UTC(2026, 9, 6, 9, 50, 0);
    const fixes: IgcFix[] = [];
    for (let s = 0; s <= 5400; s += 2) fixes.push(fix(t0 + s * 1000, direct(sss, 0, Math.max(0, s - 600) * speed)));
    return writeIgc({ header: { date: "2026-10-06" }, fixes });
  };
  const tracks = [{ id: "1", igc: igc(6) }, { id: "2", igc: igc(4) }];

  it("D7 maxTime vaut 55 min après la porte en CIVL, 60 min en PWCA", () => {
    const r = both((gapProfile) => scoreTask(task, tracks, { params, gapProfile }));
    expect(r.civl.leadingMaxTime).toBe(3300);
    expect(r.pwca.leadingMaxTime).toBe(3600);
    // Les distances, elles, s'arrêtent à 10:55 dans les deux cas.
    expect(r.pwca.pilots.map((p) => p.distance)).toEqual(r.civl.pilots.map((p) => p.distance));
  });
});

describe("D8 pénalité d'espace aérien : barème PWCA en points ou S7A en part du score", () => {
  it("D8 50 m dans un espace : 80,2 points (PWCA soft), la moitié des points (S7A)", () => {
    expect(airspacePenalty(50, 100)).toBeCloseTo((1000 * (1.05 ** 50 - 1)) / (1.05 ** 100 - 1), 9);
    expect(airspacePenalty(50, 100)).toBeCloseTo(80.2, 1);
    expect(airspacePenalty(50, 50)).toBe(1000);
    expect(airspacePenaltyFractionS7A(50)).toBeCloseTo(0.5, 9);
  });
});

describe("C1 coefficient de leading : FS et SVL s'écartent ensemble du texte du S7F", () => {
  // Le texte du S7F 2026 (12.3.1, parapente) multiplie chaque tranche par minToESS et divise par 1800 × distance
  // de la section de vitesse. FS et SVL ne font ni l'un ni l'autre : aire pondérée / 1800 seulement.
  const W = (a: number, b: number) => {
    let s = 0;
    for (let i = 0; i < 2000; i++) s += leadingWeight(a + ((i + 0.5) * (b - a)) / 2000) * ((b - a) / 2000);
    return s;
  };
  it("C1 LC = Σ taskTime × ∫weight / 1800, sans facteur de distance", () => {
    // 50 km de section de vitesse ; le pilote avance de 25 km à t = 1800 s, puis se pose. maxTime = 7200 s.
    const track = { samples: [{ t: 0, minToEss: 50 }, { t: 1800, minToEss: 25 }], madeEss: false, essTime: null, outlandingTime: 1800 };
    const lc = leadingCoefficient(track, 50, 7200);
    expect(lc).toBeCloseTo((1800 * W(0, 0.5) + 7200 * W(0.5, 1)) / 1800, 4);
    const s7fText = (25 * 1800 * W(0, 0.5) + 25 * 7200 * W(0.5, 1)) / (1800 * 50);
    expect(Math.abs(lc - s7fText) / lc).toBeGreaterThan(0.4);
  });
});
