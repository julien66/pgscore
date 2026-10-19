import { controlFlight, zoneApproaches, type FlightControl, type ZoneApproach } from "./control.js";
import { taskDistances, type TaskDistances } from "./distances.js";
import { parseIgc } from "./igc.js";
import { leadingCoefficient, leadingFactor, leadingMaxTime, leadingTrack, type LeadingProfile, type LeadingTrack } from "./leading.js";
import {
  airspaceInfringements,
  airspacePenalty,
  airspacePenaltyFractionS7A,
  type Airspace,
} from "./openair.js";
import { GAP_RULES, scoreGap, type GapProfile, type GapPoints, type GapTaskScore } from "./gap.js";
import { scoredDistance, type CompetitionParameters } from "./params.js";
import type { Task } from "./task.js";

/**
 * Calcul d'une manche à partir des traces : contrôle de chaque vol, espaces aériens, distance retenue
 * coefficient de leading, puis points GAP (S7F 10 à 13) et classement.
 */

/** Barème de pénalité d'espace aérien. */
export type AirspacePenaltyRule = "pwca-soft" | "pwca-hard" | "s7a";

export interface ScoringOptions {
  params: Pick<CompetitionParameters, "minimumDistance" | "nominalDistance" | "nominalTime">;
  airspaces?: Airspace[];
  airspacePenaltyRule?: AirspacePenaltyRule;
  /** Arrondit au mètre les limites converties depuis les pieds, comme SVL (PWCA). */
  roundAirspaceLimits?: boolean;
  leadingProfile?: LeadingProfile;
  /** Variante de la formule de points (S7F 2026 par défaut). */
  gapProfile?: GapProfile;
  /** Leading Time Ratio de la manche (0 à 0,26) ; à défaut, celui de la formule. */
  leadingTimeRatio?: number;
  /** Pilotes présents au décollage (tous sauf ABS) ; à défaut, les pilotes qui ont volé. */
  pilotsPresent?: number;
  /**
   * Fin de manche fixée par l'organisation (UTC, "HH:MM:SS") : remplace le dernier posé pour le leading
   * si elle est plus tardive (maxTime, 12.3.1), comme le « Maximum task time » de SVL.
   */
  taskEndTime?: string;
}

export interface TrackInput {
  /** Identifiant du pilote dans la manche (numéro, nom de fichier…). */
  id: string;
  /** Nom à afficher ; à défaut, celui de l'en-tête IGC. */
  name?: string;
  igc: string;
}

export type PilotStatus = "GOAL" | "ESS" | "DF" | "MIND" | "ERREUR";

export interface AirspaceResult {
  name: string;
  class: string;
  /** Pénétration maximale, en mètres. */
  depth: number;
  from: number;
  to: number;
}

export interface PilotResult {
  id: string;
  name: string;
  status: PilotStatus;
  /** Message si la trace est illisible ou inexploitable. */
  error?: string;
  startTime: number | null;
  essTime: number | null;
  goalTime: number | null;
  /** Temps de la section de vitesse, en secondes. */
  speedSectionTime: number | null;
  /** Distance parcourue (9.3), en mètres. */
  flownDistance: number;
  /** Distance retenue : bonus d'arrêt et distance minimale compris, en mètres. */
  distance: number;
  /** Manche arrêtée : altitude au-dessus du goal à l'arrêt et distance avec bonus. */
  stop: { flying: boolean; altitudeAboveGoal: number; bonusDistance: number } | null;
  leadingCoefficient: number | null;
  leadingFactor: number | null;
  airspace: AirspaceResult[];
  /** Pénalité d'espace aérien : en points (PWCA) ou en part des points du pilote (S7A, entre 0 et 1). */
  airspacePenalty: { points?: number; fraction?: number } | null;
  /** Passage au plus près des zones non validées (pour expliquer un départ ou une balise manqués). */
  approaches: ZoneApproach[];
  /** Points GAP (au dixième), null avant le classement. */
  points: GapPoints | null;
  /** Score avant pénalités, points retirés (négatif = bonus) et score final. */
  score: number | null;
  penaltyPoints: number | null;
  total: number | null;
  /** Nombre de fixes lus, et lignes illisibles. */
  fixes: number;
  warnings: number;
}

export interface TaskScoring {
  distances: TaskDistances;
  pilots: PilotResult[];
  /** Meilleur coefficient de leading, et fin de manche retenue pour le leading (s après la première porte). */
  lcMin: number | null;
  leadingMaxTime: number | null;
  /** Validités, points disponibles et répartition. */
  gap: GapTaskScore;
}

/** Contrôle d'un pilote, sans les calculs qui dépendent des autres (leading). */
export interface ControlledPilot {
  result: PilotResult;
  /** Contrôle du vol, sans les fixes (inFlight vide) : rejouer controlFlight pour les avoir. */
  control: FlightControl | null;
  leading: LeadingTrack | null;
}

export function controlPilot(task: Task, input: TrackInput, options: ScoringOptions): ControlledPilot {
  const base: PilotResult = {
    id: input.id,
    name: input.name ?? input.id,
    status: "ERREUR",
    startTime: null,
    essTime: null,
    goalTime: null,
    speedSectionTime: null,
    flownDistance: 0,
    distance: 0,
    stop: null,
    leadingCoefficient: null,
    leadingFactor: null,
    airspace: [],
    airspacePenalty: null,
    approaches: [],
    points: null,
    score: null,
    penaltyPoints: null,
    total: null,
    fixes: 0,
    warnings: 0,
  };
  let flight;
  try {
    flight = parseIgc(input.igc);
  } catch (e) {
    return { result: { ...base, error: `Trace illisible : ${(e as Error).message}` }, control: null, leading: null };
  }
  base.name = input.name ?? flight.header.pilot ?? input.id;
  base.fixes = flight.fixes.length;
  base.warnings = flight.warnings.length;
  if (flight.fixes.filter((f) => f.valid).length < 2) {
    return { result: { ...base, error: "Aucun point GPS valide dans la trace." }, control: null, leading: null };
  }

  const c = controlFlight(task, flight.fixes);
  const r: PilotResult = {
    ...base,
    startTime: c.startTime,
    essTime: c.essTime,
    goalTime: c.goalTime,
    speedSectionTime: c.speedSectionTime,
    flownDistance: c.flownDistance,
    stop: c.stopped
      ? { flying: c.stopped.flyingAtStop, altitudeAboveGoal: c.stopped.altitudeAboveGoal, bonusDistance: c.stopped.bonusDistance }
      : null,
  };
  if (!c.flight) r.error = "Pas de vol détecté dans la trace.";
  r.approaches = zoneApproaches(task, c);

  const kept = c.stopped ? c.stopped.scoredDistance : c.flownDistance;
  const sd = scoredDistance(c.flight ? kept : null, options.params);
  r.distance = c.madeGoal ? c.flownDistance : sd.distance;
  r.status = c.madeGoal ? "GOAL" : c.madeEss ? "ESS" : sd.minimumDistance ? "MIND" : "DF";

  if (options.airspaces?.length && c.inFlight.length) {
    const inf = airspaceInfringements(options.airspaces, c.inFlight, { roundLimitsToMetre: options.roundAirspaceLimits === true });
    r.airspace = inf.map((i) => ({ name: i.airspace.name, class: i.airspace.class, depth: i.depth, from: i.from, to: i.to }));
    if (inf.length) {
      const depth = Math.max(...inf.map((i) => i.depth));
      const rule = options.airspacePenaltyRule ?? "pwca-soft";
      r.airspacePenalty =
        rule === "s7a" ? { fraction: airspacePenaltyFractionS7A(depth) } : { points: airspacePenalty(depth, rule === "pwca-hard" ? 50 : 100) };
    }
  }
  const leading = leadingTrack(task, c);
  // Les fixes du vol ne servent plus au classement : on les lâche pour ne pas garder toutes les traces
  // en mémoire pendant le calcul d'une manche (des centaines de Mo pour une centaine de pilotes).
  return { result: r, control: { ...c, inFlight: [] }, leading };
}

/** Termine le calcul : leading (qui dépend de tous les pilotes) et classement. */
export function finishScoring(task: Task, pilots: ControlledPilot[], options: ScoringOptions): TaskScoring {
  const distances = taskDistances(task);
  const ssKm = distances.speedSection / 1000;
  const profile = options.leadingProfile ?? "S7F2026";
  const withLeading = pilots.filter((p) => p.leading && p.control);
  let lcMin: number | null = null;
  let maxTime: number | null = null;
  if (withLeading.length) {
    const c0 = withLeading[0]!.control!;
    const gate = c0.firstStartGate!;
    const day = Math.floor(gate / 86_400_000) * 86_400_000;
    const at = (hms: string) => {
      const [h, m, s] = hms.split(":").map(Number);
      return (day + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000 - gate) / 1000;
    };
    // Manche arrêtée : les vols s'arrêtent à l'heure d'arrêt (leadingTrack), maxTime aussi. SVL (PWCA) prend
    // l'heure d'annonce de l'arrêt comme fin de manche (« Maximum task time »).
    const cap = task.deadline ? at(task.deadline) : Infinity;
    const end = options.taskEndTime ?? (options.gapProfile === "PWCA" && c0.stopped ? task.stopAnnouncement : undefined);
    maxTime = leadingMaxTime(withLeading.map((p) => p.leading!), cap, end ? at(end) : undefined);
    for (const p of withLeading) p.result.leadingCoefficient = leadingCoefficient(p.leading!, ssKm, maxTime, profile);
    lcMin = Math.min(...withLeading.map((p) => p.result.leadingCoefficient!));
    for (const p of withLeading) p.result.leadingFactor = leadingFactor(p.result.leadingCoefficient!, lcMin, profile);
  }

  // Points GAP. Un pilote en erreur n'a pas de vol retenu : il ne compte pas parmi les volants.
  const c0 = pilots.find((p) => p.control)?.control ?? null;
  const gap = scoreGap({
    params: options.params,
    rules: GAP_RULES[options.gapProfile ?? "S7F2026"],
    ...(options.leadingTimeRatio !== undefined ? { leadingTimeRatio: options.leadingTimeRatio } : {}),
    ...(options.pilotsPresent !== undefined ? { pilotsPresent: options.pilotsPresent } : {}),
    launchToEss: distances.launchToEss,
    stopped: c0?.stopped
      ? { stopTime: c0.stopped.taskStopTime, singleGateRace: task.type === "race" && task.startGates.length <= 1, firstStartGate: c0.firstStartGate }
      : null,
    pilots: pilots.map(({ result: r }) => ({
      id: r.id,
      flying: !r.error,
      madeEss: r.status === "GOAL" || r.status === "ESS",
      madeGoal: r.status === "GOAL",
      distance: r.distance,
      flownDistance: r.flownDistance,
      speedSectionTime: r.speedSectionTime,
      startTime: r.startTime,
      leadingFactor: r.leadingFactor,
      flyingAtStop: r.stop?.flying ?? false,
      ...(r.airspacePenalty ? { penalty: r.airspacePenalty } : {}),
    })),
  });
  pilots.forEach(({ result: r }, i) => {
    const g = gap.pilots[i]!;
    r.points = g.points;
    r.score = g.score;
    r.penaltyPoints = g.penalty;
    r.total = g.total;
  });

  const rank = (s: PilotStatus) => ({ GOAL: 0, ESS: 1, DF: 2, MIND: 3, ERREUR: 4 })[s];
  const results = pilots.map((p) => p.result);
  results.sort(
    (a, b) =>
      (b.total ?? -1) - (a.total ?? -1) ||
      rank(a.status) - rank(b.status) ||
      (a.speedSectionTime ?? Infinity) - (b.speedSectionTime ?? Infinity) ||
      b.distance - a.distance ||
      a.name.localeCompare(b.name),
  );
  return { distances, pilots: results, lcMin, leadingMaxTime: maxTime, gap };
}

/** Calcul complet en une fois (pratique pour les scripts et les tests). */
export function scoreTask(task: Task, inputs: TrackInput[], options: ScoringOptions): TaskScoring {
  return finishScoring(task, inputs.map((i) => controlPilot(task, i, options)), options);
}
