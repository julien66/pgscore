import type { FlightControl } from "./control.js";
import { taskDistances } from "./distances.js";
import { distance } from "./geo.js";
import { findTaskAreaCentre } from "./projection.js";
import { RouteFrom, type RouteZone } from "./route.js";
import type { Task } from "./task.js";

/**
 * Points de leading en parapente (S7F 2026, 12.3).
 *
 * Pour chaque pilote parti, on suit la meilleure distance restante jusqu'à l'ESS (minToESS, en km)
 * au fil du temps de manche, depuis la validation du SSS jusqu'à l'ESS ou l'atterrissage.
 * Le coefficient LC est l'aire sous cette courbe, pondérée selon l'avancement dans la section
 * de vitesse, plus l'aire « manquante » pour la partie non volée. Plus LC est petit, mieux c'est.
 */

export interface LeadingSample {
  /** Temps de manche en secondes depuis la première porte, plafonné à la deadline. */
  t: number;
  /** Meilleure distance restante jusqu'à l'ESS, en km. */
  minToEss: number;
}

export interface LeadingTrack {
  samples: LeadingSample[];
  madeEss: boolean;
  /** Heure d'ESS ou d'atterrissage (posés), en secondes de manche, pour maxTime. */
  essTime: number | null;
  outlandingTime: number | null;
}

/** weight(v) parapente : montée puis descente selon l'avancement v dans la section de vitesse. */
export function leadingWeight(v: number): number {
  const rising = (1 - Math.pow(10, -9 * v)) ** 5; // weightRising(1 − v)
  const falling = (1 - Math.pow(10, 3 * v - 3)) ** 2; // weightFalling(1 − v)
  return rising * falling;
}

/** Primitive de weight sur [0, 1], tabulée (Simpson sur 20 000 intervalles), interpolée linéairement. */
const N = 20_000;
const CUMUL = (() => {
  const c = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    const a = i / N;
    const b = (i + 1) / N;
    c[i + 1] = c[i]! + ((b - a) / 6) * (leadingWeight(a) + 4 * leadingWeight((a + b) / 2) + leadingWeight(b));
  }
  return c;
})();
function weightIntegral(from: number, to: number): number {
  const W = (x: number) => {
    const u = Math.min(1, Math.max(0, x)) * N;
    const i = Math.min(N - 1, Math.floor(u));
    return CUMUL[i]! + (CUMUL[i + 1]! - CUMUL[i]!) * (u - i);
  };
  return W(to) - W(from);
}

/**
 * Courbe minToESS d'un pilote à partir de son contrôle de vol. La distance jusqu'à l'ESS depuis un
 * fix est la route optimisée par les zones pas encore atteintes jusqu'au centre de l'ESS, moins son rayon.
 */
export function leadingTrack(task: Task, control: FlightControl): LeadingTrack | null {
  const tps = task.turnpoints;
  const sssIdx = tps.findIndex((t) => t.role === "sss");
  const essIdxRaw = tps.findIndex((t) => t.role === "ess");
  const essIdx = essIdxRaw >= 0 ? essIdxRaw : tps.length - 1;
  if (control.sssTime === null || control.firstStartGate === null) return null;

  const ssKm = taskDistances(task).speedSection / 1000;
  const deadline = task.deadline ? timeOfDay(task.deadline, control.firstStartGate) : Infinity;
  const taskTime = (ms: number) => (Math.min(ms, deadline) - control.firstStartGate!) / 1000;
  const centre = findTaskAreaCentre(tps.map((t) => t.zone.waypoint));
  const essZone = tps[essIdx]!.zone;
  const essRadius = essZone.kind === "cylinder" ? essZone.radius : 0;

  const routes = new Map<number, RouteFrom>();
  const routeFrom = (next: number) => {
    let r = routes.get(next);
    if (!r) {
      const z: RouteZone[] = tps.slice(next, essIdx + 1).map((t, k) => ({
        centre: { lat: t.zone.waypoint.lat, lon: t.zone.waypoint.lon },
        radius: next + k === essIdx || t.zone.kind !== "cylinder" ? 0 : t.zone.radius,
      }));
      routes.set(next, (r = new RouteFrom(z, centre)));
    }
    return r;
  };

  const steps = control.validated.map((v) => ({ time: v.time, next: v.index + 1 }));
  const endTime = control.essTime ?? Infinity;
  const samples: LeadingSample[] = [{ t: taskTime(control.sssTime), minToEss: ssKm }];
  let best = ssKm;
  // Dernier fix calculé : la distance restante ne peut pas baisser plus vite que le déplacement
  // depuis ce fix (inégalité triangulaire). Si elle ne peut pas battre le meilleur, on ne la calcule pas.
  let ref: { lat: number; lon: number; next: number; d: number } | null = null;
  for (const f of control.inFlight) {
    if (f.time <= control.sssTime || f.time > endTime) continue;
    let next = sssIdx + 1;
    for (const s of steps) if (s.time <= f.time) next = s.next;
    let d: number;
    if (next > essIdx) d = 0;
    else {
      if (ref && ref.next === next && ref.d - distance(ref, f) / 1000 >= best) continue;
      d = Math.max(0, (routeFrom(next).distance(f) - essRadius) / 1000);
      ref = { lat: f.lat, lon: f.lon, next, d };
    }
    if (d < best) {
      best = d;
      samples.push({ t: taskTime(f.time), minToEss: best });
    }
  }
  const last = control.inFlight.at(-1);
  return {
    samples,
    madeEss: control.madeEss,
    essTime: control.essTime !== null ? taskTime(control.essTime) : null,
    outlandingTime: !control.madeEss && last ? taskTime(control.landingTime ?? last.time) : null,
  };
}

/** "HH:MM:SS" UTC le jour de la porte donnée (ms UTC). */
function timeOfDay(hms: string, sameDay: number): number {
  const [h, m, s] = hms.split(":").map(Number);
  return Math.floor(sameDay / 86_400_000) * 86_400_000 + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
}

/**
 * Variante de calcul du leading.
 * - "S7F2026" : texte du S7F 2026 (12.3), avec le facteur distance restante et √LCmin.
 * - "PWCA" : ce que fait SVL (logiciel de la PWCA), retrouvé sur les 6 manches de Baixo Guandu 2026
 *   à 0,1 point près : pas de facteur distance restante, LC divisé par 1800 seulement,
 *   et LeadingFactor divisé par LCmin au lieu de √LCmin.
 */
export type LeadingProfile = "S7F2026" | "PWCA";

/**
 * maxTime (12.3.1) : fin du dernier vol utile (dernier posé ou dernière arrivée à l'ESS), plafonnée
 * à la deadline. Si l'organisation fixe une heure de fin de manche plus tardive, elle la remplace.
 */
export function leadingMaxTime(tracks: LeadingTrack[], deadlineTaskTime = Infinity, organizerEndTaskTime?: number): number {
  let m = 0;
  for (const tr of tracks) m = Math.max(m, tr.essTime ?? 0, tr.outlandingTime ?? 0);
  if (organizerEndTaskTime !== undefined) m = Math.max(m, organizerEndTaskTime);
  return Math.min(m, deadlineTaskTime);
}

/** Coefficient de leading LC d'un pilote (12.3.1, formule parapente). */
export function leadingCoefficient(
  track: LeadingTrack,
  ssDistanceKm: number,
  maxTime: number,
  profile: LeadingProfile = "S7F2026",
): number {
  const done = (d: number) => 1 - d / ssDistanceKm;
  const withDistance = profile === "S7F2026";
  const s = track.samples;
  let area = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    if (b.minToEss < a.minToEss) {
      area += (withDistance ? b.minToEss : 1) * b.t * weightIntegral(done(a.minToEss), done(b.minToEss));
    }
  }
  const bestD = s.at(-1)!.minToEss;
  const missing = (withDistance ? bestD : 1) * maxTime * weightIntegral(done(bestD), 1);
  return (area + missing) / (withDistance ? 1800 * ssDistanceKm : 1800);
}

/** LeadingFactor (12.3) : 1 pour le meilleur LC, décroît avec l'écart au meilleur. */
export function leadingFactor(lc: number, lcMin: number, profile: LeadingProfile = "S7F2026"): number {
  const denominator = profile === "S7F2026" ? Math.sqrt(lcMin) : lcMin;
  return Math.max(0, 1 - Math.cbrt((lc - lcMin) ** 2 / denominator));
}
