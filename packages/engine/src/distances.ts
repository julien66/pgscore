import type { Task, TaskTurnpoint } from "./task.js";
import { findTaskAreaCentre } from "./projection.js";
import { optimizeRoute, type OptimizedRoute, type RouteZone } from "./route.js";

export interface TaskDistances {
  /** Distance de la manche : décollage → centre du goal, moins le rayon si le goal est un cylindre (S7F 7.1). */
  task: number;
  /** Décollage → ESS : route jusqu'au centre de l'ESS, moins son rayon. */
  launchToEss: number;
  /** Distance de la section de vitesse : décollage → ESS moins la partie avant le SSS. */
  speedSection: number;
  /** Route optimisée complète (décollage → centre du goal). */
  route: OptimizedRoute;
}

function radiusOf(tp: TaskTurnpoint): number {
  return tp.zone.kind === "cylinder" ? tp.zone.radius : 0;
}

export interface TaskDistanceOptions {
  /**
   * Agrandissement relatif des cylindres pour le calcul de la route (0 par défaut, S7F 2026 9.1).
   * 0,001 reproduit à ~10 m près les distances publiées par la PWCA en 2026.
   */
  relativeTolerance?: number;
}

/** Le décollage est un point de départ, pas une zone à atteindre. */
const isPointRole = (tp: TaskTurnpoint) => tp.role === "takeoff";

/** Distances officielles de la manche (S7F 2026, 7.1), sur l'ellipsoïde WGS84. */
export function taskDistances(task: Task, options: TaskDistanceOptions = {}): TaskDistances {
  const k = 1 + (options.relativeTolerance ?? 0);
  const toZone = (tp: TaskTurnpoint, asPoint: boolean): RouteZone => {
    const { lat, lon } = tp.zone.waypoint;
    return { centre: { lat, lon }, radius: asPoint ? 0 : radiusOf(tp) * k };
  };
  const tps = task.turnpoints;
  const goalIdx = tps.length - 1;
  const essIdx = tps.findIndex((t) => t.role === "ess");
  const sssIdx = tps.findIndex((t) => t.role === "sss");
  if (goalIdx < 1 || sssIdx < 0) throw new Error("Manche incomplète : il faut un SSS et un goal.");
  const ess = essIdx >= 0 ? essIdx : goalIdx;
  const centre = findTaskAreaCentre(tps.map((t) => t.zone.waypoint));

  const full = optimizeRoute(
    tps.map((t, i) => toZone(t, isPointRole(t) || i === goalIdx)),
    centre,
  );
  const goal = tps[goalIdx]!;
  const task_ = full.distance - (goal.zone.kind === "cylinder" ? goal.zone.radius * k : 0);

  const toEss = optimizeRoute(
    tps.slice(0, ess + 1).map((t, i) => toZone(t, isPointRole(t) || i === ess)),
    centre,
  );
  const launchToEss = toEss.distance - radiusOf(tps[ess]!) * k;
  const preStart = toEss.legs.slice(0, sssIdx).reduce((s, v) => s + v, 0);

  return { task: task_, launchToEss, speedSection: launchToEss - preStart, route: full };
}
