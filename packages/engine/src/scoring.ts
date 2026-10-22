import { controlFlight, zoneApproaches, type FlightControl, type ZoneApproach } from "./control.js";
import { taskDistances, type TaskDistances } from "./distances.js";
import { parseIgc } from "./igc.js";
import { leadingCoefficient, leadingFactor, leadingMaxTime, leadingSpeedSectionKm, leadingTrack, type LeadingEnd, type LeadingFormula, type LeadingTrack, type LeadingWarning } from "./leading.js";
import {
  airspaceInfringements,
  airspacePenalty,
  airspacePenaltyFractionS7A,
  type Airspace,
} from "./openair.js";
import { GAP_RULES, goalAltitudeFactor, scoreGap, type GapProfile, type GapPoints, type GapTaskScore } from "./gap.js";
import { scoredDistance, type CompetitionParameters } from "./params.js";
import { taskTimeFromGate, type Task } from "./task.js";

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
  /** Variante de la formule de points (S7F 2026 par défaut). */
  gapProfile?: GapProfile;
  /** Leading Time Ratio de la manche (0 à 0,26) ; à défaut, celui de la formule. */
  leadingTimeRatio?: number;
  /** Pilotes présents au décollage (tous sauf ABS) ; à défaut, les pilotes qui ont volé. */
  pilotsPresent?: number;
  /**
   * Fin de manche fixée par l'organisation (UTC, "HH:MM:SS") : remplace la fin des vols pour le leading
   * si elle est plus tardive (maxTime, 12.3.1), comme le « Maximum task time » de SVL.
   */
  taskEndTime?: string;
  /** Fin des vols pour maxTime du leading : dernière arrivée à l'ESS (par défaut) ou dernier posé s'il est plus tardif. */
  leadingEnd?: LeadingEnd;
  /** Formule du leading pour la partie de vol manquante des pilotes posés : GAP2026 (par défaut) ou GAP2025 (FS). */
  leadingFormula?: LeadingFormula;
  /** Décisions de l'organisateur, appliquées avant les points. */
  decisions?: PilotDecision[];
}

export interface TrackInput {
  /** Identifiant du pilote dans la manche (numéro, nom de fichier…). */
  id: string;
  /** Nom à afficher ; à défaut, celui de l'en-tête IGC. */
  name?: string;
  igc: string;
}

export type PilotStatus = "GOAL" | "ESS" | "DF" | "MIND" | "ERREUR" | "DNF" | "ABS";

/**
 * Décision de l'organisateur pour un pilote dans une manche.
 * - bonus / penalty : points ajoutés ou retirés (13.5) ; penalty-percent : part des points retirée (0 à 100) ;
 * - goal : goal accordé (réclamation, ligne physique franchie…) ;
 * - abs : absent, ne compte pas parmi les présents ; dnf : présent au décollage mais n'a pas volé ;
 * - launched : a décollé sans trace exploitable, reçoit la distance minimale (9.3).
 */
export type DecisionKind = "bonus" | "penalty" | "penalty-percent" | "goal" | "abs" | "dnf" | "launched";

export interface PilotDecision {
  pilot: string;
  /** Nom à afficher pour un pilote sans trace. */
  name?: string;
  kind: DecisionKind;
  value?: number;
  reason: string;
}

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
  /** Elevated goal (13.1) : altitude de passage du goal et facteur appliqué aux points de temps. */
  goalAltitude?: number | null;
  goalAltitudeFactor?: number;
  /** Points de temps perdus pour un passage trop bas de l'elevated goal. */
  goalAltitudeLoss?: number;
  /** Alertes sur la trace qui peuvent fausser le leading (trace espacée, trou, arrêt en vol). */
  leadingWarnings?: LeadingWarning[];
  airspace: AirspaceResult[];
  /** Pénalité d'espace aérien : en points (PWCA) ou en part des points du pilote (S7A, entre 0 et 1). */
  airspacePenalty: { points?: number; fraction?: number } | null;
  /** Passage au plus près des zones non validées (pour expliquer un départ ou une balise manqués). */
  approaches: ZoneApproach[];
  /** Décisions de l'organisateur appliquées à ce pilote. */
  decisions?: Array<{ kind: DecisionKind; value?: number; reason: string }>;
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

function emptyResult(id: string, name: string): PilotResult {
  return {
    id,
    name,
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
}

export function controlPilot(task: Task, input: TrackInput, options: ScoringOptions): ControlledPilot {
  const base = emptyResult(input.id, input.name ?? input.id);
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
  if (task.elevatedGoal && c.madeGoal) {
    r.goalAltitude = c.goalAltitude;
    const goalAlt = task.turnpoints.at(-1)!.zone.waypoint.altitude ?? 0;
    r.goalAltitudeFactor = c.goalAltitude === null ? 1 : goalAltitudeFactor(c.goalAltitude, goalAlt, task.elevatedGoal);
  }
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
  const leading = leadingTrack(task, c, options.gapProfile);
  if (leading?.quality?.warnings.length) r.leadingWarnings = leading.quality.warnings;
  // Les fixes du vol ne servent plus au classement : on les lâche pour ne pas garder toutes les traces
  // en mémoire pendant le calcul d'une manche (des centaines de Mo pour une centaine de pilotes).
  return { result: r, control: { ...c, inFlight: [] }, leading };
}

/** Termine le calcul : leading (qui dépend de tous les pilotes) et classement. */
export function finishScoring(task: Task, controlled: ControlledPilot[], options: ScoringOptions): TaskScoring {
  const distances = taskDistances(task);
  const pilots = applyDecisions(controlled, options.decisions ?? [], distances.task, options.params.minimumDistance);
  const ssKm = leadingSpeedSectionKm(task, options.gapProfile);
  const absent = (r: PilotResult) => r.status === "ABS" || r.status === "DNF";
  const withLeading = pilots.filter((p) => p.leading && p.control && !absent(p.result));
  let lcMin: number | null = null;
  let maxTime: number | null = null;
  if (withLeading.length) {
    const c0 = withLeading[0]!.control!;
    const gate = c0.firstStartGate!;
    // Heure de la manche en secondes après la première porte (une deadline peut passer minuit UTC).
    const at = (hms: string) => (taskTimeFromGate(task, hms, gate) - gate) / 1000;
    // Manche arrêtée : les vols s'arrêtent à l'heure d'arrêt (leadingTrack), maxTime aussi. SVL (PWCA) prend
    // en général l'heure d'annonce de l'arrêt comme fin de manche (« Maximum task time », Feltre 2025 T3),
    // mais pas toujours (Sopot 2026 T2 : arrêt à 15:51, 15:46) ; taskEndTime donne alors la valeur publiée.
    const cap = task.deadline ? at(task.deadline) : Infinity;
    const end = options.taskEndTime ?? (options.gapProfile === "PWCA" && c0.stopped ? task.stopAnnouncement : undefined);
    maxTime = leadingMaxTime(withLeading.map((p) => p.leading!), cap, end ? at(end) : undefined, options.leadingEnd);
    for (const p of withLeading) p.result.leadingCoefficient = leadingCoefficient(p.leading!, ssKm, maxTime, options.leadingFormula);
    lcMin = Math.min(...withLeading.map((p) => p.result.leadingCoefficient!));
    for (const p of withLeading) p.result.leadingFactor = leadingFactor(p.result.leadingCoefficient!, lcMin);
  }

  // Points GAP. Un pilote en erreur n'a pas de vol retenu : il ne compte pas parmi les volants.
  const c0 = pilots.find((p) => p.control)?.control ?? null;
  const gap = scoreGap({
    params: options.params,
    rules: GAP_RULES[options.gapProfile ?? "S7F2026"],
    ...(options.leadingTimeRatio !== undefined ? { leadingTimeRatio: options.leadingTimeRatio } : {}),
    // Présents : ceux qui ont volé et ceux déclarés DNF ; les absents (ABS) ne comptent pas.
    pilotsPresent: options.pilotsPresent ?? pilots.filter((p) => !p.result.error && p.result.status !== "ABS").length,
    launchToEss: distances.launchToEss,
    stopped: c0?.stopped
      ? { stopTime: c0.stopped.taskStopTime, singleGateRace: task.type === "race" && task.startGates.length <= 1, firstStartGate: c0.firstStartGate }
      : null,
    pilots: pilots.map(({ result: r }) => ({
      id: r.id,
      flying: !r.error && !absent(r),
      madeEss: r.status === "GOAL" || r.status === "ESS",
      madeGoal: r.status === "GOAL",
      distance: r.distance,
      flownDistance: r.flownDistance,
      speedSectionTime: r.speedSectionTime,
      startTime: r.startTime,
      leadingFactor: r.leadingFactor,
      flyingAtStop: r.stop?.flying ?? false,
      ...(r.status === "GOAL" && r.goalAltitudeFactor !== undefined ? { goalAltitudeFactor: r.goalAltitudeFactor } : {}),
      penalty: penaltyOf(r),
    })),
  });
  pilots.forEach(({ result: r }, i) => {
    const g = gap.pilots[i]!;
    r.points = g.points;
    r.score = g.score;
    r.penaltyPoints = g.penalty;
    r.total = g.total;
    if (g.goalAltitudeLoss !== undefined) r.goalAltitudeLoss = g.goalAltitudeLoss;
    else delete r.goalAltitudeLoss;
  });

  const rank = (s: PilotStatus) => ({ GOAL: 0, ESS: 1, DF: 2, MIND: 3, ERREUR: 4, DNF: 5, ABS: 6 })[s];
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

/**
 * Plusieurs traces pour un même pilote (deux instruments, un fichier renvoyé) : on retient celle qui lui
 * donne le plus de points. `groups` : les traces contrôlées de chaque pilote. Rend le classement et,
 * pour chaque pilote, l'indice de la trace retenue. Les points d'un pilote dépendent des autres
 * (leading, meilleure distance) : chaque essai refait donc le calcul complet, sur des copies.
 */
export function finishScoringBest(task: Task, groups: ControlledPilot[][], options: ScoringOptions): { scoring: TaskScoring; chosen: number[] } {
  const chosen = groups.map((g) => (g.length > 1 ? bestByFlight(g) : 0));
  if (groups.every((g) => g.length <= 1)) return { scoring: finishScoring(task, groups.map((g) => g[0]!), options), chosen };
  const run = (choice: number[]) => finishScoring(task, choice.map((c, i) => structuredClone(groups[i]![c]!)), options);
  const totalOf = (s: TaskScoring, id: string) => s.pilots.find((p) => p.id === id)?.total ?? -1;
  let best = run(chosen);
  for (const [i, g] of groups.entries()) {
    if (g.length < 2) continue;
    const id = g[0]!.result.id;
    for (let j = 0; j < g.length; j++) {
      if (j === chosen[i]) continue;
      const trial = [...chosen];
      trial[i] = j;
      const s = run(trial);
      if (totalOf(s, id) > totalOf(best, id) + 1e-9) {
        best = s;
        chosen[i] = j;
      }
    }
  }
  return { scoring: best, chosen };
}

/** Premier choix entre les traces d'un pilote, avant les points : goal, puis ESS, puis le plus loin, puis le plus rapide. */
function bestByFlight(g: ControlledPilot[]): number {
  const rank = (r: PilotResult) => (r.error ? 9 : ({ GOAL: 0, ESS: 1, DF: 2, MIND: 3, ERREUR: 4, DNF: 5, ABS: 6 } as const)[r.status]);
  let best = 0;
  for (let j = 1; j < g.length; j++) {
    const a = g[j]!.result;
    const b = g[best]!.result;
    const better =
      rank(a) - rank(b) ||
      b.distance - a.distance ||
      (a.speedSectionTime ?? Infinity) - (b.speedSectionTime ?? Infinity);
    if (better < 0) best = j;
  }
  return best;
}

/** Pénalités d'espace aérien et de l'organisateur, cumulées (13.5 : pourcentage puis points). */
function penaltyOf(r: PilotResult): { fraction?: number; points?: number } {
  let fraction = r.airspacePenalty?.fraction ?? 0;
  let points = r.airspacePenalty?.points ?? 0;
  for (const d of r.decisions ?? []) {
    if (d.kind === "penalty") points += d.value ?? 0;
    else if (d.kind === "bonus") points -= d.value ?? 0;
    else if (d.kind === "penalty-percent") fraction += (d.value ?? 0) / 100;
  }
  return { ...(fraction ? { fraction: Math.min(1, fraction) } : {}), ...(points ? { points } : {}) };
}

/** Applique les décisions de l'organisateur ; ajoute les pilotes sans trace (ABS, DNF, décollé sans trace). */
function applyDecisions(pilots: ControlledPilot[], decisions: PilotDecision[], taskDistance: number, minimumDistance: number): ControlledPilot[] {
  const out = [...pilots];
  const byId = new Map(out.map((p) => [p.result.id, p]));
  for (const d of decisions) {
    let p = byId.get(d.pilot);
    if (!p) {
      p = { result: emptyResult(d.pilot, d.name ?? d.pilot), control: null, leading: null };
      p.result.error = "Pas de trace.";
      out.push(p);
      byId.set(d.pilot, p);
    }
    const r = p.result;
    (r.decisions ??= []).push({ kind: d.kind, ...(d.value !== undefined ? { value: d.value } : {}), reason: d.reason });
    if (d.kind === "abs" || d.kind === "dnf") {
      r.status = d.kind === "abs" ? "ABS" : "DNF";
      r.distance = 0;
      delete r.error;
    } else if (d.kind === "launched" && (r.error || r.status === "ERREUR")) {
      delete r.error;
      r.status = "MIND";
      r.distance = minimumDistance;
    } else if (d.kind === "goal" && !r.error) {
      // Goal accordé : distance de la manche ; le temps de la section de vitesse reste celui mesuré à l'ESS.
      r.status = "GOAL";
      r.flownDistance = r.distance = taskDistance;
    }
  }
  return out;
}

/** Calcul complet en une fois (pratique pour les scripts et les tests). */
export function scoreTask(task: Task, inputs: TrackInput[], options: ScoringOptions): TaskScoring {
  return finishScoring(task, inputs.map((i) => controlPilot(task, i, options)), options);
}
