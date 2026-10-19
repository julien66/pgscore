import { direct, distance, inverse, type LatLon } from "./geo.js";
import { findTaskAreaCentre, LocalProjection, type XY } from "./projection.js";

/** Zone traversée par la route : un cercle (rayon > 0) ou un point (rayon 0). */
export interface RouteZone {
  centre: LatLon;
  radius: number;
}

export interface OptimizedRoute {
  /** Un point par zone, sur son bord (ou le point lui-même), en WGS84. */
  points: LatLon[];
  /** Longueur de chaque tronçon, en mètres. */
  legs: number[];
  /** Longueur totale sur l'ellipsoïde, en mètres. */
  distance: number;
}

/** Précision demandée à PathFinder (S7F 7.1.3). */
const EPSILON = 0.1;
const MAX_ITERATIONS = 1000;

const dist2 = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/** Point du segment [a, b] où il entre dans le cercle, ou null s'il ne le coupe pas. */
function segmentEntersCircle(a: XY, b: XY, c: XY, r: number): XY | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  if (A === 0) return C <= 0 ? a : null;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  // Premier passage sur le bord le long du segment.
  for (const t of [t1, t2].sort((u, v) => u - v)) {
    if (t >= 0 && t <= 1) return { x: a.x + t * dx, y: a.y + t * dy };
  }
  return null;
}

/** Point du cercle qui minimise |a-x| + |x-b| (a et b hors du chemin direct à travers le cercle). */
function bestPointOnCircle(a: XY, b: XY, c: XY, r: number): XY {
  const at = (theta: number): XY => ({ x: c.x + r * Math.cos(theta), y: c.y + r * Math.sin(theta) });
  const cost = (theta: number) => {
    const p = at(theta);
    return dist2(a, p) + dist2(p, b);
  };
  // Balayage grossier puis affinage par section dorée autour du meilleur angle.
  const steps = 72;
  let best = 0;
  let bestCost = Infinity;
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * 2 * Math.PI;
    const v = cost(th);
    if (v < bestCost) {
      bestCost = v;
      best = th;
    }
  }
  let lo = best - (2 * Math.PI) / steps;
  let hi = best + (2 * Math.PI) / steps;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = cost(x1);
  let f2 = cost(x2);
  while ((hi - lo) * r > 1e-4) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = cost(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = cost(x2);
    }
  }
  return at((lo + hi) / 2);
}

/**
 * PathFinder (S7F 7.1.3, d'après Ding et al. 2018) : plus court chemin plan passant
 * par une suite de cercles. Chaque point est réoptimisé entre ses voisins jusqu'à
 * ce qu'aucun ne bouge de plus de ε.
 */
export function pathFinder(zones: Array<{ c: XY; r: number }>): XY[] {
  const pts: XY[] = zones.map((z) => ({ ...z.c }));
  if (zones.length < 2) return pts;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = 0;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]!;
      if (z.r <= 0) continue;
      const prev = i > 0 ? pts[i - 1]! : null;
      const next = i < zones.length - 1 ? pts[i + 1]! : null;
      let p: XY;
      if (prev && next) {
        p = segmentEntersCircle(prev, next, z.c, z.r) ?? bestPointOnCircle(prev, next, z.c, z.r);
      } else {
        // Première ou dernière zone : point du bord le plus proche du voisin.
        const o = (prev ?? next)!;
        const d = dist2(o, z.c);
        p = d === 0 ? { x: z.c.x + z.r, y: z.c.y } : { x: z.c.x + ((o.x - z.c.x) * z.r) / d, y: z.c.y + ((o.y - z.c.y) * z.r) / d };
      }
      moved = Math.max(moved, dist2(p, pts[i]!));
      pts[i] = p;
    }
    if (moved < EPSILON) break;
  }
  return pts;
}

/**
 * RouteOptimizer (S7F 7.1.8) : projection LTM, PathFinder, retour en WGS84,
 * correction sur le bord des zones (7.1.7), puis somme des distances sur l'ellipsoïde.
 */
export function optimizeRoute(zones: RouteZone[], centre?: LatLon): OptimizedRoute {
  if (zones.length === 0) return { points: [], legs: [], distance: 0 };
  const proj = new LocalProjection(centre ?? findTaskAreaCentre(zones.map((z) => z.centre)));
  const planar = pathFinder(zones.map((z) => ({ c: proj.toXY(z.centre), r: z.radius })));
  const points = planar.map((p, i) => {
    const z = zones[i]!;
    const ll = proj.toLatLon(p);
    if (z.radius <= 0) return { ...z.centre };
    // ProjectionCorrection : ramener le point exactement sur le bord du cercle, sur l'ellipsoïde.
    const az = inverse(z.centre, ll).azimuth1;
    const corrected = direct(z.centre, az, z.radius);
    return { lat: corrected.lat, lon: corrected.lon };
  });
  const legs: number[] = [];
  for (let i = 1; i < points.length; i++) legs.push(distance(points[i - 1]!, points[i]!));
  return { points, legs, distance: legs.reduce((s, v) => s + v, 0) };
}
