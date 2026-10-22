import type { CompetitionParameters } from "./params.js";

/**
 * Points GAP d'une manche de parapente (S7F 2026, chapitres 10 à 13) : validité, répartition des
 * points disponibles et score de chaque pilote. Le calcul ne dépend que des résultats du contrôle
 * (distances, temps, coefficient de leading) : il est rejouable sans les traces.
 */

/** Variante de formule. */
export type GapProfile = "S7F2026" | "PWCA";

export interface GapRules {
  /** Coefficients du poids distance : d + c·G + b·G² + a·G³ (11). */
  distanceWeight: { d: number; c: number; b: number; a: number };
  /** Leading Time Ratio par défaut (11), entre 0 et 0,26. */
  leadingTimeRatio: number;
  /** Décimales des points disponibles : au dixième, comme FS (GAP2026) et SVL (PWCA). */
  availableDecimals: number;
  /** Meilleur temps pris parmi les pilotes au goal seulement (S7F 12.2.1) ; sinon parmi ceux à l'ESS. */
  bestTimeFromGoal: boolean;
  /**
   * Taux de goal de la répartition compté sur les seuls pilotes au goal qui ont des points de temps
   * (SVL « Goal ratio from time points ») : un pilote arrivé trop tard pour en avoir ne compte pas.
   */
  goalRatioFromTimePoints: boolean;
  /**
   * Leading compté sur la section de vitesse la plus courte depuis le bord du SSS, sans tolérance de cylindre
   * (SVL « Speed Section distance (shortest) ») ; sinon sur celle de la route optimisée complète (FS).
   */
  leadingShortestSpeedSection: boolean;
}

export const GAP_RULES: Record<GapProfile, GapRules> = {
  S7F2026: {
    distanceWeight: { d: 0.9, c: -1.665, b: 1.713, a: -0.587 },
    leadingTimeRatio: 0.26,
    availableDecimals: 1,
    bestTimeFromGoal: true,
    goalRatioFromTimePoints: false,
    leadingShortestSpeedSection: false,
  },
  // Formule GAP_PWCA_2026 de SVL : coefficients arrondis, LTR de 26,3158 %, points disponibles au dixième,
  // meilleur temps pris sur tous les pilotes à l'ESS (« Best time from goal = false »).
  PWCA: {
    distanceWeight: { d: 0.9, c: -1.67, b: 1.71, a: -0.59 },
    leadingTimeRatio: 0.263158,
    availableDecimals: 1,
    bestTimeFromGoal: false,
    goalRatioFromTimePoints: true,
    leadingShortestSpeedSection: true,
  },
};

/** Nominal Launch et Nominal Goal, fixés depuis 2025 (10.1, 10.2). */
export const NOMINAL_LAUNCH = 0.96;
export const NOMINAL_GOAL = 0.3;

export interface GapPilotInput {
  id: string;
  /** A décollé (compté dans les pilotes volants). */
  flying: boolean;
  madeEss: boolean;
  madeGoal: boolean;
  /** Distance retenue en mètres : distance minimale et bonus d'arrêt compris (12.1, 13.4.6). */
  distance: number;
  /** Distance parcourue en mètres, sans bonus d'arrêt (validités). */
  flownDistance: number;
  /** Temps de la section de vitesse, en secondes. */
  speedSectionTime: number | null;
  /** Heure de départ retenue, ms UTC. */
  startTime: number | null;
  /** Facteur de leading (12.3), entre 0 et 1. */
  leadingFactor: number | null;
  /** Manche arrêtée : le pilote volait encore à l'heure d'arrêt. */
  flyingAtStop?: boolean;
  /** Elevated goal (13.1) : facteur des points de temps selon l'altitude de passage du goal (0,8 à 1). */
  goalAltitudeFactor?: number;
  /** Pénalité : en part des points (0 à 1, appliquée d'abord), puis en points (13.5). Négative = bonus. */
  penalty?: { fraction?: number; points?: number };
}

export interface GapTaskInput {
  params: Pick<CompetitionParameters, "nominalDistance" | "minimumDistance" | "nominalTime">;
  rules: GapRules;
  /** Leading Time Ratio de la manche ; à défaut, celui du règlement. */
  leadingTimeRatio?: number;
  /** Pilotes présents au décollage (tous sauf ABS) ; à défaut, les pilotes volants. */
  pilotsPresent?: number;
  /** Distance décollage → ESS, en mètres (validité d'arrêt). */
  launchToEss: number;
  /** Manche arrêtée : heure d'arrêt après score-back, ms UTC, et type de départ (13.4). */
  stopped?: { stopTime: number; singleGateRace: boolean; firstStartGate: number | null } | null;
  pilots: GapPilotInput[];
}

export interface GapValidity {
  launch: number;
  distance: number;
  time: number;
  /** Validité d'arrêt (13.4.3), null si la manche n'est pas arrêtée. */
  stopped: number | null;
  task: number;
}

export interface GapPoints {
  distance: number;
  time: number;
  leading: number;
  arrival: number;
}

export interface GapPilotScore {
  id: string;
  points: GapPoints;
  /** Score avant pénalités, au dixième. */
  score: number;
  /** Points retirés par les pénalités (négatif pour un bonus). */
  penalty: number;
  /** Score final, au dixième, jamais négatif. */
  total: number;
  /** Elevated goal (13.1) : points de temps perdus pour un passage trop bas. */
  goalAltitudeLoss?: number;
}

export interface GapTaskScore {
  pilotsPresent: number;
  pilotsFlying: number;
  pilotsEss: number;
  pilotsGoal: number;
  goalRatio: number;
  /** Meilleure distance retenue, en mètres. */
  bestDistance: number;
  /** Meilleur temps de la section de vitesse, en secondes. */
  bestTime: number | null;
  leadingTimeRatio: number;
  validity: GapValidity;
  weights: GapPoints;
  available: GapPoints;
  /** Manche arrêtée avec des pilotes au goal : points de temps retirés à chacun et reversés en distance (13.4.5). */
  timePointsReduction: number;
  pilots: GapPilotScore[];
}

export const round = (v: number, decimals: number): number => {
  const f = 10 ** decimals;
  // Le petit décalage évite qu'un 0,05 représenté 0,04999… soit arrondi vers le bas.
  return Math.round(v * f + Math.sign(v) * 1e-9) / f;
};

/** Validité de décollage (10.1). */
export function launchValidity(flying: number, present: number): number {
  if (flying <= 0 || present <= 0) return 0;
  const lvr = Math.min(1, flying / (present * NOMINAL_LAUNCH));
  return Math.min(1, 0.028 * lvr + 2.917 * lvr ** 2 - 1.944 * lvr ** 3);
}

/** Validité de distance (10.2) ; distances en mètres. */
export function distanceValidity(flown: number[], minimumDistance: number, nominalDistance: number, bestDistance: number): number {
  if (!flown.length) return 0;
  const sum = flown.reduce((s, d) => s + Math.max(0, d - minimumDistance), 0);
  const area =
    ((NOMINAL_GOAL + 1) * (nominalDistance - minimumDistance) + Math.max(0, NOMINAL_GOAL * (bestDistance - nominalDistance))) / 2;
  return area > 0 ? Math.min(1, sum / (flown.length * area)) : 0;
}

/** Validité de temps (10.3) à partir du rapport meilleur temps / temps nominal (ou meilleure distance / distance nominale). */
export function timeValidity(ratio: number): number {
  const x = Math.min(1, ratio);
  return Math.max(0, Math.min(1, -0.271 + 2.912 * x - 2.098 * x ** 2 + 0.457 * x ** 3));
}

/** Part des points de temps (12.2) : temps en secondes, calcul en heures. */
export function speedFraction(time: number, bestTime: number): number {
  const t = time / 3600;
  const best = bestTime / 3600;
  if (t <= best) return 1;
  return Math.max(0, 1 - ((t - best) / Math.sqrt(best)) ** (5 / 6));
}

/** Validité d'arrêt (13.4.3) ; distances en mètres, calcul en kilomètres. */
export function stoppedValidity(input: {
  pilotsEss: number;
  flown: number[];
  launchToEss: number;
  flyingAtStop: number;
  launched: number;
}): number {
  if (input.pilotsEss > 0) return 1;
  const km = input.flown.map((d) => d / 1000);
  if (!km.length || input.launched <= 0) return 0;
  const best = Math.max(...km);
  const avg = km.reduce((s, d) => s + d, 0) / km.length;
  const stdev = Math.sqrt(km.reduce((s, d) => s + (d - avg) ** 2, 0) / km.length);
  const ratio = Math.max(0, (best - avg) / (input.launchToEss / 1000 - best + 1));
  const distanceValidity = Math.sqrt(ratio * Math.sqrt(stdev / 5));
  const landed = input.launched - input.flyingAtStop;
  const flyingValidity = (landed / input.launched) ** 3;
  // La durée minimale est nulle en parapente (13.4.2) : la validité de durée vaut toujours 1.
  return Math.min(1, distanceValidity + flyingValidity);
}

/** Calcul GAP complet d'une manche. */
export function scoreGap(input: GapTaskInput): GapTaskScore {
  const { params, rules } = input;
  const flying = input.pilots.filter((p) => p.flying);
  const pilotsFlying = flying.length;
  const pilotsPresent = Math.max(input.pilotsPresent ?? pilotsFlying, pilotsFlying);
  const ess = flying.filter((p) => p.madeEss && p.speedSectionTime !== null);
  const goal = flying.filter((p) => p.madeGoal);
  const bestDistance = Math.max(0, ...flying.map((p) => p.distance));
  const timed = rules.bestTimeFromGoal ? ess.filter((p) => p.madeGoal) : ess;
  const bestTime = timed.length ? Math.min(...timed.map((p) => p.speedSectionTime!)) : null;
  const goalForRatio = rules.goalRatioFromTimePoints
    ? goal.filter((p) => p.speedSectionTime !== null && bestTime !== null && speedFraction(p.speedSectionTime, bestTime) > 0)
    : goal;
  const goalRatio = pilotsFlying ? goalForRatio.length / pilotsFlying : 0;

  // Validité (10, 13.4.3).
  const flownForValidity = flying.map((p) => p.flownDistance);
  const bestFlown = Math.max(0, ...flownForValidity);
  const lv = launchValidity(pilotsFlying, pilotsPresent);
  const dv = distanceValidity(flownForValidity, params.minimumDistance, params.nominalDistance, bestFlown);
  const tv = timeValidity(bestTime !== null ? bestTime / params.nominalTime : bestFlown / params.nominalDistance);
  const sv = input.stopped
    ? stoppedValidity({
        pilotsEss: ess.length,
        flown: flownForValidity,
        launchToEss: input.launchToEss,
        flyingAtStop: flying.filter((p) => p.flyingAtStop).length,
        launched: pilotsFlying,
      })
    : null;
  const task = pilotsFlying ? lv * dv * tv * (sv ?? 1) : 0;

  // Répartition (11).
  const ltr = input.leadingTimeRatio ?? rules.leadingTimeRatio;
  const { d, c, b, a } = rules.distanceWeight;
  const dw = d + c * goalRatio + b * goalRatio ** 2 + a * goalRatio ** 3;
  const lw = goalRatio === 0 ? 1 - dw : (1 - dw) * ltr;
  const weights: GapPoints = { distance: dw, leading: lw, arrival: 0, time: 1 - dw - lw };
  const avail = (w: number) => round(1000 * task * w, rules.availableDecimals);
  // Le temps prend le reste : arrondies chacune de leur côté, les trois parts pouvaient faire 1001
  // (ou 1000,1 au dixième) ; ainsi leur somme reste égale à 1000 × validité, arrondie.
  const distanceAvail = avail(weights.distance);
  const leadingAvail = avail(weights.leading);
  const available: GapPoints = {
    distance: distanceAvail,
    time: Math.max(0, round(avail(1) - distanceAvail - leadingAvail, rules.availableDecimals)),
    leading: leadingAvail,
    arrival: 0,
  };
  // Sans pilote à l'ESS, pas de points de temps (Figure 13) ; sans goal (13.4.5, 1), ils ne sont pas reversés.
  if (bestTime === null) available.time = 0;

  // Manche arrêtée avec des pilotes au goal (13.4.5) : réduction des points de temps reversée en distance.
  let timePointsReduction = 0;
  if (input.stopped && goal.length && bestTime !== null) {
    const stop = input.stopped.stopTime;
    // Pilotes entre l'ESS et le goal à l'heure d'arrêt : encore en vol. Un pilote posé après l'ESS, avant le
    // goal, n'y est plus (US Open Chelan 2026 T1 : posé derrière la ligne une heure et demie avant l'arrêt).
    const essNotGoal = flying.filter((p) => p.madeEss && !p.madeGoal && p.startTime !== null && p.flyingAtStop);
    let refTime: number | null = null;
    if (essNotGoal.length) {
      refTime = Math.min(...essNotGoal.map((p) => p.speedSectionTime ?? Infinity));
    } else {
      const starts = flying.filter((p) => p.startTime !== null).map((p) => p.startTime!);
      const start = input.stopped.singleGateRace ? input.stopped.firstStartGate ?? Math.min(...starts) : Math.max(...starts);
      if (Number.isFinite(start)) refTime = (stop - start) / 1000;
    }
    if (refTime !== null && Number.isFinite(refTime)) {
      timePointsReduction = round(speedFraction(Math.max(refTime, bestTime), bestTime) * available.time, 1);
      available.distance = round(available.distance + timePointsReduction, 1);
    }
  }

  const pilots: GapPilotScore[] = input.pilots.map((p) => {
    if (!p.flying) return { id: p.id, points: { distance: 0, time: 0, leading: 0, arrival: 0 }, score: 0, penalty: 0, total: 0 };
    const distance = bestDistance > 0 ? round((p.distance / bestDistance) * available.distance, 1) : 0;
    // ESS sans goal : pas de points de temps en parapente (13.2).
    let time = 0;
    let goalAltitudeLoss: number | undefined;
    if (p.madeGoal && p.speedSectionTime !== null && bestTime !== null) {
      time = speedFraction(p.speedSectionTime, bestTime) * available.time;
      if (timePointsReduction) time = Math.max(0, time - timePointsReduction);
      time = round(time, 1);
      if (p.goalAltitudeFactor !== undefined && p.goalAltitudeFactor < 1) {
        const reduced = round(time * p.goalAltitudeFactor, 1);
        goalAltitudeLoss = round(time - reduced, 1);
        time = reduced;
      }
    }
    const leading = p.leadingFactor !== null ? round(p.leadingFactor * available.leading, 1) : 0;
    const score = round(distance + time + leading, 1);
    let total = score;
    if (p.penalty?.fraction) total = total * (1 - p.penalty.fraction);
    if (p.penalty?.points) total = total - p.penalty.points;
    total = Math.max(0, round(total, 1));
    return {
      id: p.id,
      points: { distance, time, leading, arrival: 0 },
      score,
      penalty: round(score - total, 1),
      total,
      ...(goalAltitudeLoss !== undefined ? { goalAltitudeLoss } : {}),
    };
  });

  return {
    pilotsPresent,
    pilotsFlying,
    pilotsEss: ess.length,
    pilotsGoal: goal.length,
    goalRatio,
    bestDistance,
    bestTime,
    leadingTimeRatio: ltr,
    validity: { launch: lv, distance: dv, time: tv, stopped: sv, task },
    weights,
    available,
    timePointsReduction,
    pilots,
  };
}

/**
 * Elevated goal (13.1) : facteur des points de temps d'un pilote qui passe le goal à l'altitude `crossing`,
 * pour un goal publié à `goalAltitude` et élevé de `elevation` mètres. 0,8 au niveau du goal ou dessous,
 * 1 à partir de l'élévation, entre les deux 0,8 + 0,6·AR − 0,6·AR² + 0,2·AR³ avec AR la part de l'élévation atteinte.
 */
export function goalAltitudeFactor(crossing: number, goalAltitude: number, elevation: number): number {
  if (!(elevation > 0) || crossing >= goalAltitude + elevation) return 1;
  if (crossing <= goalAltitude) return 0.8;
  const ar = (crossing - goalAltitude) / elevation;
  return 0.8 + 0.6 * ar - 0.6 * ar * ar + 0.2 * ar ** 3;
}
