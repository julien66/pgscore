import { distance, inverse, sphericalDistance, SPHERICAL_TOLERANCE, type LatLon } from "./geo.js";
import type { IgcFix } from "./igc.js";
import { taskDistances } from "./distances.js";
import { detectFlights, type FlightPeriod } from "./flight.js";
import { findTaskAreaCentre } from "./projection.js";
import { RouteFrom, type RouteZone } from "./route.js";
import type { Task, TaskTurnpoint } from "./task.js";

/** Tolérance absolue des cylindres et des lignes (S7F 2026, 9.1). */
export const ABSOLUTE_TOLERANCE = 5;
/** Tolérance relative des cylindres : 0 % en 2026 (9.1.1). */
export const RELATIVE_TOLERANCE = 0;

export interface ZoneValidation {
  /** Index de la balise dans task.turnpoints. */
  index: number;
  name: string;
  role: TaskTurnpoint["role"];
  /** Heure de validation, ms UTC : heure du fix qui réalise le passage (9.2.1). */
  time: number;
  /** Altitude de validation (GNSS, sinon pression), en mètres. */
  altitude: number | null;
}

export interface FlightControl {
  /** Zones validées dans l'ordre (SSS compris, décollage exclu). */
  validated: ZoneValidation[];
  /** Validation du SSS, ms UTC. */
  sssTime: number | null;
  /** Heure de départ retenue (9.2.4.1) : porte pour une race, passage du SSS pour un time trial. */
  startTime: number | null;
  essTime: number | null;
  goalTime: number | null;
  /** Altitude (GNSS, sinon pression) du fix qui valide le goal, en mètres (elevated goal, 13.1). */
  goalAltitude: number | null;
  /** Temps de la section de vitesse, en secondes. */
  speedSectionTime: number | null;
  madeEss: boolean;
  madeGoal: boolean;
  /** Distance parcourue (9.3), en mètres : distance de la manche pour un pilote au goal. */
  flownDistance: number;
  /** Fix où la distance restante est la plus faible (meilleur point), pour les pilotes posés. */
  bestPoint: (LatLon & { time: number }) | null;
  /** Vol retenu dans la trace (index dans les fixes valides). */
  flight: FlightPeriod | null;
  /** Heure d'atterrissage, ms UTC, si le pilote s'est posé avant la fin de la trace. */
  landingTime: number | null;
  /** Fixes du vol retenu (du décollage à l'atterrissage). */
  inFlight: IgcFix[];
  /** Première porte de départ de la manche, ms UTC. */
  firstStartGate: number | null;
  /** Manche arrêtée : fin de la fenêtre prise en compte pour ce pilote et bonus d'altitude (13.4). */
  stopped: StoppedFlight | null;
}

export interface StoppedFlight {
  /** Heure d'arrêt après score-back, ms UTC. */
  taskStopTime: number;
  /** Fin de la fenêtre de vol prise en compte pour ce pilote (13.4.4), ms UTC. */
  windowEnd: number;
  /** Le pilote volait encore à la fin de sa fenêtre. */
  flyingAtStop: boolean;
  /** Altitude GNSS au-dessus du goal à la fin de la fenêtre, en mètres (0 si posé). */
  altitudeAboveGoal: number;
  /** Distance à l'arrêt plus bonus d'altitude, plafonnée à la distance de la manche (13.4.6), en mètres. */
  bonusDistance: number;
  /** Distance retenue : max(distance parcourue, bonusDistance), en mètres. */
  scoredDistance: number;
}

/** Finesse du bonus d'altitude en parapente (13.4.6). */
export const BONUS_GLIDE_RATIO = 2.5;
/** Score-back par défaut en parapente (13.4.1), en secondes. */
export const DEFAULT_SCORE_BACK_TIME = 300;
/** Une trace qui finit plus tôt que ça avant l'heure d'arrêt ne compte pas comme en vol à l'arrêt (s). */
export const STOP_TRACK_SLACK = 60;

export interface ControlOptions {
  /**
   * Manche arrêtée avec plusieurs portes ou en time trial (13.4.4) : dernière heure de départ
   * officielle (dernière porte prise par au moins un pilote), ms UTC. Par défaut, la dernière porte
   * avant l'arrêt ; en time trial sans porte, le départ du pilote.
   */
  lastStartTime?: number;
}

const alt = (f: IgcFix) => f.gnssAltitude ?? f.pressureAltitude;

/** "HH:MM:SS" UTC → ms UTC, le jour de la trace. */
function timeOnDay(hms: string, dayStart: number): number {
  const [h, m, s] = hms.split(":").map(Number);
  return dayStart + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
}

/** Repère plan local (m) centré sur un point : suffisant à l'échelle d'une ligne de goal. */
function localXY(centre: LatLon, p: LatLon): { x: number; y: number } {
  const { distance: d, azimuth1 } = inverse(centre, p);
  const a = (azimuth1 * Math.PI) / 180;
  return { x: d * Math.sin(a), y: d * Math.cos(a) };
}

/**
 * Passages d'un cylindre (9.2.1) : entrée ou sortie de la bande de tolérance, par son bord
 * intérieur ou extérieur, dans n'importe quel sens. L'heure est celle du second fix.
 * Renvoie les index des fixes qui réalisent un passage.
 */
function cylinderCrossings(pts: IgcFix[], centre: LatLon, radius: number, relative = RELATIVE_TOLERANCE): number[] {
  const inner = Math.min(radius * (1 - relative), radius - ABSOLUTE_TOLERANCE);
  const outer = Math.max(radius * (1 + relative), radius + ABSOLUTE_TOLERANCE);
  const out: number[] = [];
  // Position de chaque fix par rapport aux deux bords (dedans, bande, dehors). L'estimation sphérique
  // suffit quand elle est loin des deux bords ; près d'un bord, distance WGS84 exacte.
  const zone = (p: IgcFix): number => {
    const s = sphericalDistance(centre, p);
    const m = s * SPHERICAL_TOLERANCE + 1;
    const d = (s < inner - m || s > outer + m || (s > inner + m && s < outer - m)) ? s : distance(centre, p);
    return d < inner ? 0 : d <= outer ? 1 : 2;
  };
  let prev = zone(pts[0]!);
  for (let j = 1; j < pts.length; j++) {
    const z = zone(pts[j]!);
    if (z !== prev) out.push(j);
    prev = z;
  }
  return out;
}

/**
 * Passages du goal en ligne avec demi-cercle (9.2.3.1) : le segment entre deux fixes touche le
 * bord extérieur de la zone de tolérance (ligne décalée de 5 m vers l'arrivée, demi-cercle agrandi de 5 m).
 */
function goalLineCrossings(pts: IgcFix[], centre: LatLon, length: number, incoming: { x: number; y: number }): number[] {
  const half = length / 2;
  const T = ABSOLUTE_TOLERANCE;
  const R = half + T;
  const out: number[] = [];
  // s : distance signée vers le côté d'arrivée ; l : position le long de la ligne.
  const sl = (p: LatLon) => {
    const v = localXY(centre, p);
    return { s: v.x * incoming.x + v.y * incoming.y, l: -v.x * incoming.y + v.y * incoming.x };
  };
  // Zone de tolérance : { s <= T et |l| <= R et (s >= 0 ou s² + l² <= R²) }.
  const inside = (q: { s: number; l: number }) =>
    q.s <= T && Math.abs(q.l) <= R && (q.s >= 0 || q.s * q.s + q.l * q.l <= R * R);
  let a = sl(pts[0]!);
  for (let j = 1; j < pts.length; j++) {
    const b = sl(pts[j]!);
    let hit = inside(b) && !inside(a);
    if (!hit && a.s > T && b.s < -T) {
      // Segment qui traverse la zone sans fix dedans : on teste le passage sur la ligne décalée.
      const f = (a.s - T) / (a.s - b.s);
      const l = a.l + (b.l - a.l) * f;
      hit = Math.abs(l) <= R;
    }
    if (hit) out.push(j);
    a = b;
  }
  return out;
}

/**
 * Contrôle d'une trace sur une manche (S7F 2026, 9.2 et 9.3) : départ, balises dans l'ordre,
 * ESS, goal et distance parcourue. Seule la partie en vol compte.
 */
export function controlFlight(task: Task, fixes: IgcFix[], options: ControlOptions = {}): FlightControl {
  const valid = fixes.filter((f) => f.valid);
  if (!task.stopAnnouncement || !valid.length) return controlUntil(task, valid, Infinity);
  const dayStart = Math.floor(valid[0]!.time / 86_400_000) * 86_400_000;
  const stop = timeOnDay(task.stopAnnouncement, dayStart) - (task.scoreBackTime ?? DEFAULT_SCORE_BACK_TIME) * 1000;
  const gates = task.startGates.map((g) => timeOnDay(g, dayStart)).sort((a, b) => a - b);

  // Fenêtre de vol (13.4.4) : jusqu'à l'arrêt pour une race à une porte ; sinon, la même durée
  // pour tous, comptée depuis le départ de chacun.
  let end = stop;
  if (task.type === "time-trial" || gates.length > 1) {
    const first = controlUntil(task, valid, stop);
    if (first.startTime !== null) {
      const lastStart = options.lastStartTime ?? [...gates].reverse().find((g) => g <= stop) ?? first.startTime;
      end = Math.min(stop, first.startTime + (stop - lastStart));
    }
  }
  const c = controlUntil(task, valid, end);
  const distances = taskDistances(task);
  // Une trace qui s'arrête en vol bien avant l'heure d'arrêt ne prouve pas que le pilote volait encore :
  // pas de bonus d'altitude (comme SVL, Sopot 2026 T2 pilote 725, trace finie 45 min avant l'arrêt).
  const lastFix = c.inFlight.at(-1);
  const flying =
    c.inFlight.length > 0 &&
    c.inFlight[0]!.time <= end &&
    (c.landingTime === null || c.landingTime > end) &&
    lastFix !== undefined &&
    lastFix.time >= end - STOP_TRACK_SLACK * 1000;
  let altitudeAboveGoal = 0;
  let bonusDistance = 0;
  if (flying && !c.madeGoal) {
    // Bonus d'altitude (13.4.6) : depuis la position à l'arrêt, sans tenir compte des meilleures distances d'avant.
    const p = c.inFlight.at(-1)!;
    const goalAlt = task.turnpoints.at(-1)!.zone.waypoint.altitude ?? 0;
    altitudeAboveGoal = Math.max(0, (alt(p) ?? goalAlt) - goalAlt);
    const sssIdx = task.turnpoints.findIndex((t) => t.role === "sss");
    const remaining = remainingFrom(task, c.validated, sssIdx)(p);
    bonusDistance = Math.min(distances.task, distances.task - remaining + altitudeAboveGoal * (task.bonusGlideRatio ?? BONUS_GLIDE_RATIO));
  }
  c.stopped = {
    taskStopTime: stop,
    windowEnd: end,
    flyingAtStop: flying,
    altitudeAboveGoal,
    bonusDistance,
    scoredDistance: Math.max(c.flownDistance, bonusDistance),
  };
  return c;
}

/** Contrôle de la trace jusqu'à `end` (ms UTC) : les fixes après cette heure sont ignorés. */
function controlUntil(task: Task, valid: IgcFix[], end: number): FlightControl {
  const tps = task.turnpoints;
  const sssIdx = tps.findIndex((t) => t.role === "sss");
  const goalIdx = tps.length - 1;
  const essIdx = tps.findIndex((t) => t.role === "ess");
  const ess = essIdx >= 0 ? essIdx : goalIdx;
  const distances = taskDistances(task);

  const dayStart = valid.length ? Math.floor(valid[0]!.time / 86_400_000) * 86_400_000 : 0;
  const gates = task.startGates.map((g) => timeOnDay(g, dayStart)).sort((a, b) => a - b);
  const firstGate = gates[0] ?? -Infinity;

  // Vol retenu : le dernier décollage avant la première porte (redécollage), sinon le premier vol.
  const flights = detectFlights(valid);
  const before = flights.filter((f) => valid[f.takeoffIndex]!.time < firstGate);
  const period = before.at(-1) ?? flights[0] ?? null;

  const result: FlightControl = {
    validated: [],
    sssTime: null,
    startTime: null,
    essTime: null,
    goalTime: null,
    goalAltitude: null,
    speedSectionTime: null,
    madeEss: false,
    madeGoal: false,
    flownDistance: 0,
    bestPoint: null,
    flight: period,
    landingTime: period?.landed ? (valid[period.landingIndex]?.time ?? null) : null,
    inFlight: [],
    firstStartGate: gates[0] ?? null,
    stopped: null,
  };
  if (!period || sssIdx < 0) return result;
  const pts = valid.slice(period.takeoffIndex, period.landingIndex + 1).filter((f) => f.time <= end);
  result.inFlight = pts;
  if (pts.length < 2) return result;

  // Orientation de la ligne de goal : perpendiculaire à la route optimisée qui y arrive (6.2.3.1), ou à la
  // direction du centre de la balise précédente en degrés bruts (goalLineOrientation "previousCentre").
  const crossingsOf = (i: number): number[] => {
    const z = tps[i]!.zone;
    if (z.kind === "cylinder") return cylinderCrossings(pts, z.waypoint, z.radius, task.cylinderTolerance ?? RELATIVE_TOLERANCE);
    const c = z.waypoint;
    let v = localXY(c, distances.route.points[i - 1]!);
    if (task.goalLineOrientation === "previousCentre") {
      let j = i - 1;
      while (j > 0 && tps[j]!.zone.waypoint.lat === c.lat && tps[j]!.zone.waypoint.lon === c.lon) j--;
      const w = tps[j]!.zone.waypoint;
      v = { x: w.lon - c.lon, y: w.lat - c.lat };
    }
    const n = Math.hypot(v.x, v.y) || 1;
    return goalLineCrossings(pts, z.waypoint, z.length, { x: v.x / n, y: v.y / n });
  };

  const deadline = task.deadline ? timeOnDay(task.deadline, dayStart) : Infinity;
  const zv = (i: number, j: number): ZoneValidation => ({
    index: i,
    name: tps[i]!.zone.waypoint.name,
    role: tps[i]!.role,
    time: pts[j]!.time,
    altitude: alt(pts[j]!),
  });
  const firstAfter = (list: number[], afterIdx: number) =>
    list.find((j) => j > afterIdx && pts[j]!.time >= firstGate && pts[j]!.time <= deadline);

  // SSS (9.2.4) : premier passage après la porte s'il n'y a qu'une porte ; sinon (plusieurs portes,
  // time trial) dernier passage avant la validation de la balise suivante.
  const sssList = crossingsOf(sssIdx);
  let sssJ = firstAfter(sssList, -1);
  const validated: ZoneValidation[] = [];
  if (sssJ !== undefined) {
    if (task.type === "time-trial" || gates.length > 1) {
      const nextJ = sssIdx + 1 <= goalIdx ? firstAfter(crossingsOf(sssIdx + 1), sssJ) : undefined;
      const limit = nextJ ?? pts.length;
      const last = [...sssList].reverse().find((j) => j < limit && pts[j]!.time >= firstGate);
      if (last !== undefined) sssJ = last;
    }
    validated.push(zv(sssIdx, sssJ));
    let prevJ = sssJ;
    for (let i = sssIdx + 1; i <= goalIdx; i++) {
      const j = firstAfter(crossingsOf(i), prevJ);
      if (j === undefined) break;
      validated.push(zv(i, j));
      prevJ = j;
    }
  }

  result.validated = validated;
  const at = (i: number) => validated.find((v) => v.index === i)?.time ?? null;
  result.sssTime = at(sssIdx);
  if (result.sssTime !== null) {
    const gate = [...gates].reverse().find((g) => g <= result.sssTime!) ?? null;
    result.startTime = task.type === "race" && gate !== null ? gate : result.sssTime;
  }
  result.essTime = at(ess);
  result.goalTime = at(goalIdx);
  result.goalAltitude = validated.find((v) => v.index === goalIdx)?.altitude ?? null;
  result.madeEss = result.essTime !== null;
  result.madeGoal = result.goalTime !== null;
  if (result.essTime !== null && result.startTime !== null) {
    result.speedSectionTime = (result.essTime - result.startTime) / 1000;
  }

  // Distance parcourue (9.3).
  if (result.madeGoal) {
    result.flownDistance = distances.task;
  } else {
    const best = bestRemaining(task, pts, validated, sssIdx);
    result.flownDistance = Math.max(0, distances.task - best.remaining);
    if (best.index >= 0) {
      const p = pts[best.index]!;
      result.bestPoint = { lat: p.lat, lon: p.lon, time: p.time };
    }
  }
  return result;
}

/**
 * Distance restante la plus faible le long de la trace (9.3) : depuis chaque fix, route optimisée
 * par les zones pas encore atteintes jusqu'au centre du goal.
 */
function bestRemaining(
  task: Task,
  pts: IgcFix[],
  validated: ZoneValidation[],
  sssIdx: number,
): { remaining: number; index: number } {
  const remaining = remainingFrom(task, validated, sssIdx);
  const remainingAt = (j: number): number => remaining(pts[j]!);

  // Recherche exacte sur tous les fixes. La distance restante ne peut pas baisser plus vite que le
  // déplacement depuis le dernier fix calculé (inégalité triangulaire) : on saute les fixes qui ne
  // peuvent pas battre le meilleur, sans route optimisée.
  const steps = validated.map((v) => ({ time: v.time, next: v.index + 1 }));
  const nextAt = (t: number) => {
    let next = sssIdx;
    for (const s of steps) if (s.time <= t) next = s.next;
    return next;
  };
  // Premier passage : un fix sur STRIDE, calculé. Second passage : un fix n'est calculé que si la
  // borne tirée des fixes calculés voisins (inégalité triangulaire) peut battre le meilleur.
  // Le résultat est exact ; seuls les abords du meilleur point sont calculés fix par fix.
  const STRIDE = 20;
  const nexts = pts.map((p) => nextAt(p.time));
  const known = new Map<number, number>();
  let best = { remaining: Infinity, index: -1 };
  const take = (j: number) => {
    let r = known.get(j);
    if (r === undefined) known.set(j, (r = remainingAt(j)));
    if (r < best.remaining) best = { remaining: r, index: j };
    return r;
  };
  for (let j = 0; j < pts.length; j += STRIDE) take(j);
  if (pts.length) take(pts.length - 1);
  for (let j = 0; j < pts.length; j++) {
    if (known.has(j)) continue;
    const p = pts[j]!;
    let bound = -Infinity;
    for (const s of [Math.floor(j / STRIDE) * STRIDE, Math.min(pts.length - 1, (Math.floor(j / STRIDE) + 1) * STRIDE)]) {
      const r = known.get(s);
      if (r !== undefined && nexts[s] === nexts[j]) bound = Math.max(bound, r - distance(pts[s]!, p));
    }
    if (bound >= best.remaining) continue;
    take(j);
  }
  return best;
}

/** Distance restante jusqu'au goal depuis un fix, compte tenu des zones déjà validées à son heure (9.3). */
function remainingFrom(task: Task, validated: ZoneValidation[], sssIdx: number): (p: IgcFix) => number {
  const tps = task.turnpoints;
  const goalIdx = tps.length - 1;
  const steps = validated.map((v) => ({ time: v.time, next: v.index + 1 }));
  // Mêmes cylindres agrandis que pour la distance de la manche (taskDistances), sinon distance de la
  // manche moins distance restante sous-estime la distance parcourue.
  const tol = 1 + (task.cylinderTolerance ?? 0);
  const goalZone = tps[goalIdx]!.zone;
  const goalRadius = goalZone.kind === "cylinder" ? goalZone.radius * tol : 0;
  const zonesFrom = (next: number): RouteZone[] =>
    tps.slice(next).map((t, k) => ({
      centre: { lat: t.zone.waypoint.lat, lon: t.zone.waypoint.lon },
      radius: next + k === goalIdx || t.zone.kind !== "cylinder" ? 0 : t.zone.radius * tol,
    }));
  // Une route par jeu de zones restantes, projetée une fois autour du centre de la manche.
  const centre = findTaskAreaCentre(tps.map((t) => t.zone.waypoint));
  const cache = new Map<number, RouteFrom>();
  return (p) => {
    // Prochaine zone à atteindre à l'instant de ce fix.
    let next = sssIdx;
    for (const s of steps) if (s.time <= p.time) next = s.next;
    if (next > goalIdx) return 0;
    let route = cache.get(next);
    if (!route) cache.set(next, (route = new RouteFrom(zonesFrom(next), centre)));
    // Comme la distance de la manche (7.1), la distance restante va jusqu'au bord d'un goal cylindre.
    const r = route.route(p);
    const lastLeg = r.legs.at(-1) ?? 0;
    // Arrivée par l'intérieur du goal (goal de 40 km autour du décollage) : il reste à en sortir.
    if (goalRadius > 0 && lastLeg < goalRadius) return Math.max(0, r.distance - lastLeg + (goalRadius - lastLeg));
    return Math.max(0, r.distance - goalRadius);
  };
}

export interface ZoneApproach {
  /** Index de la balise dans task.turnpoints. */
  index: number;
  name: string;
  role: TaskTurnpoint["role"];
  reached: boolean;
  /**
   * Passage le plus proche du bord de la zone dans la fenêtre où elle restait à valider
   * (après la porte pour le départ, après la validation précédente pour les autres).
   * distance : écart au bord en mètres, positif dehors, négatif dedans.
   */
  closest: { distance: number; time: number; lat: number; lon: number; altitude: number | null } | null;
}

/**
 * Passages au plus près des zones non validées, pour expliquer un contrôle au pilote
 * (« le départ a été manqué de 230 m à 13:42 »). Les zones validées sont rendues avec leur heure.
 */
export function zoneApproaches(task: Task, control: FlightControl): ZoneApproach[] {
  const tps = task.turnpoints;
  const sssIdx = tps.findIndex((t) => t.role === "sss");
  if (sssIdx < 0) return [];
  const out: ZoneApproach[] = [];
  let after = control.firstStartGate ?? -Infinity;
  for (let i = sssIdx; i < tps.length; i++) {
    const tp = tps[i]!;
    const v = control.validated.find((x) => x.index === i);
    if (v) {
      out.push({ index: i, name: tp.zone.waypoint.name, role: tp.role, reached: true, closest: null });
      after = v.time;
      continue;
    }
    const radius = tp.zone.kind === "cylinder" ? tp.zone.radius : tp.zone.length / 2;
    let best: ZoneApproach["closest"] = null;
    for (const f of control.inFlight) {
      if (f.time < after) continue;
      const d = distance(tp.zone.waypoint, f) - radius;
      if (!best || Math.abs(d) < Math.abs(best.distance)) best = { distance: d, time: f.time, lat: f.lat, lon: f.lon, altitude: alt(f) };
    }
    out.push({ index: i, name: tp.zone.waypoint.name, role: tp.role, reached: false, closest: best });
  }
  return out;
}
