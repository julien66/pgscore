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

/**
 * Point du cercle qui minimise |a-x| + |x-b| (a et b hors du chemin direct à travers le cercle).
 * hint : point voisin de la solution (celle du fix précédent) ; on part de là par la méthode de
 * Newton, qui converge en deux ou trois pas. Sinon, ou si Newton ne converge pas sur l'arc tourné
 * vers a et b, section dorée.
 */
export function bestPointOnCircle(a: XY, b: XY, c: XY, r: number, hint?: XY): XY {
  const at = (theta: number): XY => ({ x: c.x + r * Math.cos(theta), y: c.y + r * Math.sin(theta) });
  const cost = (theta: number) => {
    const px = c.x + r * Math.cos(theta);
    const py = c.y + r * Math.sin(theta);
    return Math.hypot(a.x - px, a.y - py) + Math.hypot(px - b.x, py - b.y);
  };
  if (hint && Math.hypot(hint.x - c.x, hint.y - c.y) > r / 2) {
    let th = Math.atan2(hint.y - c.y, hint.x - c.x);
    for (let k = 0; k < 12; k++) {
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const ux = c.x + r * cs - a.x, uy = c.y + r * sn - a.y;
      const vx = c.x + r * cs - b.x, vy = c.y + r * sn - b.y;
      const U = Math.hypot(ux, uy), V = Math.hypot(vx, vy);
      if (U < 1e-9 || V < 1e-9) break;
      const tx = -r * sn, ty = r * cs;
      const tu = tx * ux + ty * uy, tv = tx * vx + ty * vy;
      // x'' = -(x - c) ; |x'|² = r².
      const xu = -(r * cs * ux + r * sn * uy), xv = -(r * cs * vx + r * sn * vy);
      const d1 = tu / U + tv / V;
      const d2 = (xu + r * r) / U - (tu * tu) / (U * U * U) + (xv + r * r) / V - (tv * tv) / (V * V * V);
      if (!(d2 > 0)) break;
      const step = Math.max(-0.2, Math.min(0.2, -d1 / d2));
      th += step;
      if (Math.abs(step) * r < 1e-5) {
        // Accepté si c'est bien un minimum de l'arc tourné vers a et b (même arc que la section dorée).
        const da = Math.hypot(a.x - c.x, a.y - c.y) || 1, db = Math.hypot(b.x - c.x, b.y - c.y) || 1;
        const mx = (a.x - c.x) / da + (b.x - c.x) / db, my = (a.y - c.y) / da + (b.y - c.y) / db;
        if (Math.hypot(mx, my) > 1e-6 && Math.cos(th - Math.atan2(my, mx)) > 0) return at(th);
        break;
      }
    }
  }
  // Le minimum est sur l'arc tourné vers a et b, de part et d'autre de la bissectrice des directions
  // c→a et c→b : section dorée sur ±90° autour d'elle. Si a et b sont à l'opposé l'un de l'autre,
  // balayage complet comme avant.
  const da = Math.hypot(a.x - c.x, a.y - c.y) || 1;
  const db = Math.hypot(b.x - c.x, b.y - c.y) || 1;
  const ux = (a.x - c.x) / da + (b.x - c.x) / db;
  const uy = (a.y - c.y) / da + (b.y - c.y) / db;
  let lo: number;
  let hi: number;
  if (Math.hypot(ux, uy) > 1e-6) {
    const mid = Math.atan2(uy, ux);
    lo = mid - Math.PI / 2;
    hi = mid + Math.PI / 2;
  } else {
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
    lo = best - (2 * Math.PI) / steps;
    hi = best + (2 * Math.PI) / steps;
  }
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
export function pathFinder(zones: Array<{ c: XY; r: number }>, init?: XY[]): XY[] {
  // Départ : centres des zones, ou solution voisine (route depuis le fix précédent) qui converge en quelques passes.
  const pts: XY[] = init && init.length === zones.length ? init.map((p, i) => (zones[i]!.r <= 0 ? { ...zones[i]!.c } : { ...p })) : zones.map((z) => ({ ...z.c }));
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
        p = segmentEntersCircle(prev, next, z.c, z.r) ?? bestPointOnCircle(prev, next, z.c, z.r, pts[i]);
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
  return toEllipsoid(proj, zones, pathFinder(zones.map((z) => ({ c: proj.toXY(z.centre), r: z.radius }))));
}

/** Retour en WGS84, correction sur le bord des zones (7.1.7) et longueur sur l'ellipsoïde. */
function toEllipsoid(proj: LocalProjection, zones: RouteZone[], planar: XY[]): OptimizedRoute {
  const points = planar.map((p, i) => {
    const z = zones[i]!;
    if (z.radius <= 0) return { ...z.centre };
    const ll = proj.toLatLon(p);
    // ProjectionCorrection : ramener le point exactement sur le bord du cercle, sur l'ellipsoïde.
    const az = inverse(z.centre, ll).azimuth1;
    const corrected = direct(z.centre, az, z.radius);
    return { lat: corrected.lat, lon: corrected.lon };
  });
  const legs: number[] = [];
  for (let i = 1; i < points.length; i++) legs.push(distance(points[i - 1]!, points[i]!));
  return { points, legs, distance: legs.reduce((s, v) => s + v, 0) };
}

/** Déplacement plan (au carré, m²) sous lequel un point de route garde sa correction et ses tronçons. */
const REUSE = 1;

/**
 * Routes optimisées depuis des points successifs (les fixes d'une trace) par les mêmes zones :
 * même calcul qu'optimizeRoute, mais la projection est faite une fois et PathFinder repart de la
 * route trouvée pour le point précédent, qui en est très proche. Beaucoup plus rapide sur une trace.
 */
export class RouteFrom {
  private readonly proj: LocalProjection;
  private readonly tail: Array<{ c: XY; r: number }>;
  private last: XY[] | undefined;
  // Points corrigés sur l'ellipsoïde (avec le point plan dont ils viennent) et longueurs de tronçons,
  // réutilisés tant que PathFinder laisse le point à moins de REUSE du point d'origine. Au voisinage
  // de l'optimum, la longueur de la route ne varie qu'au second ordre avec ce déplacement (moins d'un
  // millimètre pour 1 m) : seuls les premiers tronçons sont recalculés d'un fix à l'autre.
  private source: XY[] = [];
  private lastPoints: LatLon[] = [];
  private lastLegs: number[] = [];

  constructor(
    private readonly zones: RouteZone[],
    centre: LatLon,
  ) {
    this.proj = new LocalProjection(centre);
    this.tail = zones.map((z) => ({ c: this.proj.toXY(z.centre), r: z.radius }));
  }

  route(p: LatLon): OptimizedRoute {
    const start = { c: this.proj.toXY(p), r: 0 };
    const planar = pathFinder([start, ...this.tail], this.last);
    const same = planar.map((q, i) => i > 0 && this.source[i] !== undefined && dist2(q, this.source[i]!) < REUSE);
    this.last = planar;
    this.source = planar.map((q, i) => (same[i] ? this.source[i]! : q));
    const all = [{ centre: { lat: p.lat, lon: p.lon }, radius: 0 }, ...this.zones];
    const points = planar.map((q, i) => {
      if (same[i]) return this.lastPoints[i]!;
      const z = all[i]!;
      if (z.radius <= 0) return { ...z.centre };
      const ll = this.proj.toLatLon(q);
      const corrected = direct(z.centre, inverse(z.centre, ll).azimuth1, z.radius);
      return { lat: corrected.lat, lon: corrected.lon };
    });
    const legs: number[] = [];
    for (let i = 1; i < points.length; i++) legs.push(same[i - 1] && same[i] ? this.lastLegs[i - 1]! : distance(points[i - 1]!, points[i]!));
    this.lastPoints = points;
    this.lastLegs = legs;
    return { points, legs, distance: legs.reduce((s, v) => s + v, 0) };
  }

  distance(p: LatLon): number {
    return this.route(p).distance;
  }
}
