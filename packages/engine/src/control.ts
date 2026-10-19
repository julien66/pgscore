import { distance, inverse, type LatLon } from "./geo.js";
import type { IgcFix } from "./igc.js";
import { taskDistances } from "./distances.js";
import { detectFlights, type FlightPeriod } from "./flight.js";
import { optimizeRoute, type RouteZone } from "./route.js";
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
function cylinderCrossings(pts: IgcFix[], centre: LatLon, radius: number): number[] {
  const inner = Math.min(radius * (1 - RELATIVE_TOLERANCE), radius - ABSOLUTE_TOLERANCE);
  const outer = Math.max(radius * (1 + RELATIVE_TOLERANCE), radius + ABSOLUTE_TOLERANCE);
  const out: number[] = [];
  let prev = distance(centre, pts[0]!);
  for (let j = 1; j < pts.length; j++) {
    const d = distance(centre, pts[j]!);
    if (prev < inner !== d < inner || prev <= outer !== d <= outer) out.push(j);
    prev = d;
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
export function controlFlight(task: Task, fixes: IgcFix[]): FlightControl {
  const tps = task.turnpoints;
  const sssIdx = tps.findIndex((t) => t.role === "sss");
  const goalIdx = tps.length - 1;
  const essIdx = tps.findIndex((t) => t.role === "ess");
  const ess = essIdx >= 0 ? essIdx : goalIdx;
  const distances = taskDistances(task);

  const valid = fixes.filter((f) => f.valid);
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
    speedSectionTime: null,
    madeEss: false,
    madeGoal: false,
    flownDistance: 0,
    bestPoint: null,
    flight: period,
    landingTime: period?.landed ? (valid[period.landingIndex]?.time ?? null) : null,
  };
  if (!period || sssIdx < 0) return result;
  const pts = valid.slice(period.takeoffIndex, period.landingIndex + 1);
  if (pts.length < 2) return result;

  // Orientation de la ligne de goal : perpendiculaire à la route optimisée qui y arrive (6.2.3.1).
  const crossingsOf = (i: number): number[] => {
    const z = tps[i]!.zone;
    if (z.kind === "cylinder") return cylinderCrossings(pts, z.waypoint, z.radius);
    const prev = distances.route.points[i - 1]!;
    const v = localXY(z.waypoint, prev);
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
  const tps = task.turnpoints;
  const goalIdx = tps.length - 1;
  const steps = validated.map((v) => ({ time: v.time, next: v.index + 1 }));
  const zonesFrom = (next: number): RouteZone[] =>
    tps.slice(next).map((t, k) => ({
      centre: { lat: t.zone.waypoint.lat, lon: t.zone.waypoint.lon },
      radius: next + k === goalIdx || t.zone.kind !== "cylinder" ? 0 : t.zone.radius,
    }));
  const cache = new Map<number, RouteZone[]>();
  const remainingAt = (j: number): number => {
    const p = pts[j]!;
    // Prochaine zone à atteindre à l'instant de ce fix.
    let next = sssIdx;
    for (const s of steps) if (s.time <= p.time) next = s.next;
    if (next > goalIdx) return 0;
    let zones = cache.get(next);
    if (!zones) cache.set(next, (zones = zonesFrom(next)));
    return optimizeRoute([{ centre: { lat: p.lat, lon: p.lon }, radius: 0 }, ...zones]).distance;
  };

  // Recherche grossière (un fix sur 10), puis fine autour des meilleurs candidats.
  const coarse: Array<{ j: number; r: number }> = [];
  for (let j = 0; j < pts.length; j += 10) coarse.push({ j, r: remainingAt(j) });
  coarse.push({ j: pts.length - 1, r: remainingAt(pts.length - 1) });
  coarse.sort((a, b) => a.r - b.r);
  let best = { remaining: Infinity, index: -1 };
  for (const c of coarse.slice(0, 5)) {
    for (let j = Math.max(0, c.j - 10); j <= Math.min(pts.length - 1, c.j + 10); j++) {
      const r = remainingAt(j);
      if (r < best.remaining) best = { remaining: r, index: j };
    }
  }
  return best;
}
