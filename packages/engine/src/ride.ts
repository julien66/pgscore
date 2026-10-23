import type { IgcFix } from "./igc.js";

/**
 * Trajets en véhicule pris pour des vols : plusieurs traqueurs restés allumés dans la même navette.
 *
 * La détection de vol voit une descente de 500 m en dix minutes sur la route du décollage comme un plouf
 * (Siatista 2024, manche 1 : 14 traqueurs partis à la même seconde, une heure et demie après la porte).
 * Ce qui la trahit : les traces restent collées l'une à l'autre. Deux parapentes ne volent pas à quelques
 * mètres l'un de l'autre pendant des minutes ; dans la même voiture, les traqueurs restent à 2 à 6 m.
 * Sur la même manche, les vrais pilotes les plus proches (un gaggle) restent à 140 m et plus en médiane.
 */

/** Pas d'échantillonnage des positions comparées, en secondes. */
export const RIDE_STEP = 5;
/** Écart sous lequel deux positions au même instant sont confondues, en mètres. */
export const RIDE_RADIUS = 30;
/** Durée commune minimale, en secondes : en deçà, rien ne permet de conclure. */
export const RIDE_MIN_SECONDS = 180;
/** Part des positions d'un vol qui doivent être confondues avec celles de l'autre trace. */
export const RIDE_SHARE = 0.8;
/** Trou au-delà duquel on n'interpole pas entre deux fixes, en secondes. */
const MAX_GAP = 30;

/** Positions d'un vol aux instants multiples de RIDE_STEP (secondes UTC), interpolées entre les fixes. */
export interface RideSamples {
  /** Premier instant, en secondes UTC (multiple de RIDE_STEP). */
  start: number;
  /** Latitudes et longitudes ; NaN là où la trace a un trou. */
  lat: Float64Array;
  lon: Float64Array;
  /** Nombre de positions connues (hors trous). */
  count: number;
}

export function rideSamples(fixes: IgcFix[]): RideSamples | null {
  if (fixes.length < 2) return null;
  const t0 = Math.ceil(fixes[0]!.time / 1000 / RIDE_STEP) * RIDE_STEP;
  const t1 = Math.floor(fixes.at(-1)!.time / 1000 / RIDE_STEP) * RIDE_STEP;
  if (t1 < t0) return null;
  const n = (t1 - t0) / RIDE_STEP + 1;
  const lat = new Float64Array(n).fill(NaN);
  const lon = new Float64Array(n).fill(NaN);
  let j = 0;
  let count = 0;
  for (let k = 0; k < n; k++) {
    const t = (t0 + k * RIDE_STEP) * 1000;
    while (j < fixes.length - 2 && fixes[j + 1]!.time <= t) j++;
    const a = fixes[j]!;
    const b = fixes[j + 1]!;
    if (t < a.time || t > b.time || b.time - a.time > MAX_GAP * 1000) continue;
    const f = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
    lat[k] = a.lat + (b.lat - a.lat) * f;
    lon[k] = a.lon + (b.lon - a.lon) * f;
    count++;
  }
  return { start: t0, lat, lon, count };
}

/** Écart au carré, en m², entre deux positions proches (projection locale suffisante sous 1 km). */
function gap2(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = (lat2 - lat1) * 111_195;
  const x = (lon2 - lon1) * 111_195 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return x * x + y * y;
}

/** Part des positions de `a` confondues avec celles de `b` au même instant, si elles ont assez de temps en commun. */
function sharedShare(a: RideSamples, b: RideSamples): number {
  const from = Math.max(a.start, b.start);
  const to = Math.min(a.start + (a.lat.length - 1) * RIDE_STEP, b.start + (b.lat.length - 1) * RIDE_STEP);
  if (to - from < RIDE_MIN_SECONDS) return 0;
  const own = a.count;
  if (own * RIDE_STEP < RIDE_MIN_SECONDS) return 0;
  const r2 = RIDE_RADIUS * RIDE_RADIUS;
  // Arrêt dès que la part ne peut plus être atteinte : la plupart des paires s'arrêtent vite.
  const allowed = own * (1 - RIDE_SHARE);
  let near = 0;
  let missed = 0;
  for (let k = 0; k < a.lat.length; k++) {
    const la = a.lat[k]!;
    if (Number.isNaN(la)) continue;
    const t = a.start + k * RIDE_STEP;
    const kb = (t - b.start) / RIDE_STEP;
    const lb = kb >= 0 && kb < b.lat.length ? b.lat[kb]! : NaN;
    if (!Number.isNaN(lb) && gap2(la, a.lon[k]!, lb, b.lon[kb]!) <= r2) near++;
    else if (++missed > allowed) return 0;
  }
  return near / own;
}

/**
 * Traces qui ont fait le même trajet qu'une autre : pour chaque trace, les indices des autres traces dont
 * elle est restée à moins de RIDE_RADIUS pendant au moins RIDE_SHARE de son vol (et au moins
 * RIDE_MIN_SECONDS en commun). Les traces d'un même pilote (même `owner`) ne sont pas comparées.
 */
export function sharedRides(samples: Array<RideSamples | null>, owner: string[]): number[][] {
  const out = samples.map(() => [] as number[]);
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    if (!a) continue;
    for (let j = i + 1; j < samples.length; j++) {
      const b = samples[j];
      if (!b || owner[i] === owner[j]) continue;
      if (sharedShare(a, b) >= RIDE_SHARE) out[i]!.push(j);
      if (sharedShare(b, a) >= RIDE_SHARE) out[j]!.push(i);
    }
  }
  return out;
}
