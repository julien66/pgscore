import type { FlightControl } from "./control.js";
import { taskDistances } from "./distances.js";
import { GAP_RULES, type GapProfile } from "./gap.js";
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
  /** Régularité de la trace pendant la période de leading (du départ à l'ESS, l'atterrissage ou l'arrêt). */
  quality?: LeadingQuality;
}

/**
 * Une trace espacée ou trouée fausse le leading : entre deux fixes, la distance restante reste figée
 * à sa dernière valeur, donc le coefficient monte (le pilote est désavantagé). La trace qui s'arrête
 * en vol, elle, fait finir le vol au dernier fix.
 */
export interface LeadingQuality {
  /** Fixes pendant la période de leading. */
  fixes: number;
  /** Intervalle médian entre deux fixes et plus grand trou, en secondes. */
  medianInterval: number;
  maxGap: number;
  /** Début du plus grand trou (ms UTC). */
  maxGapAt: number | null;
  /** La trace s'arrête avant l'atterrissage, l'ESS, l'arrêt de manche ou la deadline. */
  endsInFlight: boolean;
  /** Alertes ; vide si la trace est bonne. */
  warnings: LeadingWarning[];
}

/** Trace espacée (intervalle médian), trou (plus grand), ou trace arrêtée avant l'atterrissage. */
export type LeadingWarning = { kind: "sparse"; seconds: number } | { kind: "gap"; seconds: number } | { kind: "ends-in-flight" };

/** Seuils d'alerte : intervalle médian au-delà duquel la trace est jugée espacée, et trou signalé. */
export const LEADING_SPARSE_INTERVAL = 5;
export const LEADING_GAP = 60;

export function leadingQuality(times: number[], endsInFlight: boolean): LeadingQuality {
  const gaps = times.slice(1).map((t, i) => (t - times[i]!) / 1000);
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianInterval = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  let maxGap = 0;
  let maxGapAt: number | null = null;
  gaps.forEach((g, i) => {
    if (g > maxGap) [maxGap, maxGapAt] = [g, times[i]!];
  });
  const warnings: LeadingWarning[] = [];
  if (medianInterval > LEADING_SPARSE_INTERVAL) warnings.push({ kind: "sparse", seconds: Math.round(medianInterval) });
  if (maxGap >= LEADING_GAP) warnings.push({ kind: "gap", seconds: Math.round(maxGap) });
  if (endsInFlight) warnings.push({ kind: "ends-in-flight" });
  return { fixes: times.length, medianInterval, maxGap, maxGapAt, endsInFlight, warnings };
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
 * Distance de section de vitesse du leading, en km. FS (S7F) prend celle de la route optimisée complète ;
 * SVL (PWCA) la plus courte depuis le bord du SSS, sans tolérance de cylindre (la distance restante des
 * pilotes se calcule elle aussi sur les rayons nominaux). French Open 2026 T4 : 45,65 km contre 44,34.
 */
export function leadingSpeedSectionKm(task: Task, profile: GapProfile = "S7F2026"): number {
  return GAP_RULES[profile].leadingShortestSpeedSection
    ? taskDistances(task, { relativeTolerance: 0 }).speedSectionShortest / 1000
    : taskDistances(task).speedSection / 1000;
}

/**
 * Courbe minToESS d'un pilote à partir de son contrôle de vol. La distance jusqu'à l'ESS depuis un
 * fix est la route optimisée par les zones pas encore atteintes jusqu'au centre de l'ESS, moins son rayon.
 */
export function leadingTrack(task: Task, control: FlightControl, profile: GapProfile = "S7F2026"): LeadingTrack | null {
  const tps = task.turnpoints;
  const sssIdx = tps.findIndex((t) => t.role === "sss");
  const essIdxRaw = tps.findIndex((t) => t.role === "ess");
  const essIdx = essIdxRaw >= 0 ? essIdxRaw : tps.length - 1;
  if (control.sssTime === null || control.firstStartGate === null) return null;

  const ssKm = leadingSpeedSectionKm(task, profile);
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
  // Manche arrêtée : rien après l'heure d'arrêt ne compte (13.4.5).
  const endTime = Math.min(control.essTime ?? Infinity, control.stopped?.taskStopTime ?? Infinity);
  const samples: LeadingSample[] = [{ t: taskTime(control.sssTime), minToEss: ssKm }];
  let best = ssKm;
  // Dernier fix calculé : la distance restante ne peut pas baisser plus vite que le déplacement
  // depuis ce fix (inégalité triangulaire). Si elle ne peut pas battre le meilleur, on ne la calcule pas.
  let ref: { lat: number; lon: number; next: number; d: number } | null = null;
  const times: number[] = [control.sssTime];
  for (const f of control.inFlight) {
    if (f.time <= control.sssTime || f.time > endTime) continue;
    times.push(f.time);
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
  const endsInFlight = !control.madeEss && control.landingTime === null && !control.stopped && last !== undefined && last.time < deadline;
  return {
    samples,
    quality: leadingQuality(times, endsInFlight),
    madeEss: control.madeEss,
    essTime: control.essTime !== null ? taskTime(control.essTime) : null,
    outlandingTime:
      !control.madeEss && last ? taskTime(Math.min(control.landingTime ?? last.time, control.stopped?.taskStopTime ?? Infinity)) : null,
  };
}

/** "HH:MM:SS" UTC le jour de la porte donnée (ms UTC). */
function timeOfDay(hms: string, sameDay: number): number {
  const [h, m, s] = hms.split(":").map(Number);
  return Math.floor(sameDay / 86_400_000) * 86_400_000 + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
}

/**
 * Fin des vols pour maxTime : "lastEss" (par défaut) prend la dernière arrivée à l'ESS, les posés ne comptant
 * que si personne n'y est arrivé (paramètre maxtime de Flymaster, German Open 2026) ; "lastLanding" (12.3.1)
 * prend le dernier posé s'il est plus tardif.
 */
export type LeadingEnd = "lastLanding" | "lastEss";

/**
 * maxTime (12.3.1) : fin du dernier vol utile (dernier posé ou dernière arrivée à l'ESS), plafonnée
 * à la deadline. Si l'organisation fixe une heure de fin de manche plus tardive, elle la remplace.
 */
export function leadingMaxTime(
  tracks: LeadingTrack[],
  deadlineTaskTime = Infinity,
  organizerEndTaskTime?: number,
  end: LeadingEnd = "lastEss",
): number {
  let m = 0;
  const essOnly = end === "lastEss" && tracks.some((tr) => tr.essTime !== null);
  for (const tr of tracks) m = Math.max(m, tr.essTime ?? 0, essOnly ? 0 : (tr.outlandingTime ?? 0));
  if (organizerEndTaskTime !== undefined) m = Math.max(m, organizerEndTaskTime);
  return Math.min(m, deadlineTaskTime);
}

/**
 * Coefficient de leading LC d'un pilote (12.3.1, formule parapente), calculé comme FS (CIVL) et SVL (PWCA) :
 * sans le facteur de distance restante du texte S7F, et divisé par 1800 seulement. Retrouvé à 0,1 point
 * près sur Baixo Guandu 2026 (SVL) et la manche 1 du French Open 2026 (FS).
 */
export function leadingCoefficient(
  track: LeadingTrack,
  ssDistanceKm: number,
  maxTime: number,
): number {
  const done = (d: number) => 1 - d / ssDistanceKm;
  const s = track.samples;
  let area = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    if (b.minToEss < a.minToEss) {
      area += b.t * weightIntegral(done(a.minToEss), done(b.minToEss));
    }
  }
  const bestD = s.at(-1)!.minToEss;
  const missing = maxTime * weightIntegral(done(bestD), 1);
  return (area + missing) / 1800;
}

/** LeadingFactor (12.3) : 1 pour le meilleur LC, décroît avec l'écart au meilleur (divisé par LCmin, comme FS et SVL). */
export function leadingFactor(lc: number, lcMin: number): number {
  return Math.max(0, 1 - Math.cbrt((lc - lcMin) ** 2 / lcMin));
}
