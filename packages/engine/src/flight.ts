import { distance } from "./geo.js";
import type { IgcFix } from "./igc.js";

export interface FlightPeriod {
  /** Index du premier fix en vol. */
  takeoffIndex: number;
  /** Index du dernier fix en vol (posé ou fin de trace). */
  landingIndex: number;
  landed: boolean;
}

/** Fenêtre d'immobilité qui marque l'atterrissage. */
const STILL_SECONDS = 60;
/** Déplacement horizontal maximal pendant cette fenêtre, en mètres. */
const STILL_DISTANCE = 30;
/** Variation d'altitude maximale pendant cette fenêtre, en mètres. */
const STILL_ALTITUDE = 5;

const alt = (f: IgcFix) => f.gnssAltitude ?? f.pressureAltitude;

/** Au sol, on marche : moins de 2,5 m/s de vitesse sol et moins de 0,5 m/s de vitesse verticale, sur 20 s. */
const WALK_SECONDS = 20;
const WALK_SPEED = 2.5;
const WALK_VERTICAL = 0.5;

/**
 * Atterrissage réel avant une immobilité trouvée en `still` : on remonte tant que le pilote se déplace
 * à pied (lentement et à altitude quasi constante). Un pilote posé juste avant une balise qui y marche
 * ne la valide pas.
 */
function walkBack(fixes: IgcFix[], still: number, takeoff: number): number {
  let k = still;
  for (;;) {
    const b = fixes[k]!;
    let j = k;
    while (j > takeoff && b.time - fixes[j - 1]!.time <= WALK_SECONDS * 1000) j--;
    const a = fixes[j]!;
    const dt = (b.time - a.time) / 1000;
    if (j <= takeoff || dt < WALK_SECONDS / 2) return k;
    const ha = alt(a);
    const hb = alt(b);
    const vz = ha !== null && hb !== null ? Math.abs(hb - ha) / dt : 0;
    if (distance(a, b) / dt >= WALK_SPEED || vz >= WALK_VERTICAL) return k;
    k = j;
  }
}

/** Écart d'altitude maximal avec le point d'immobilité pour un fix encore au sol, en mètres (bruit GNSS). */
const TOUCHDOWN_ALTITUDE = 3;

/**
 * Posé au fix près. La marche (`walkBack`) se mesure par fenêtres de 20 s, dont la dernière peut encore
 * contenir quelques secondes au sol ; l'immobilité, qui tolère 30 m, peut commencer un peu avant le posé.
 * On avance donc jusqu'à la fin du dernier segment rapide, puis on remonte fix par fix tant que le segment
 * qui arrive au fix est lent (vitesse de marche) et que le fix d'avant est à l'altitude du sol.
 * Le fix renvoyé est le premier au sol.
 */
function touchdown(fixes: IgcFix[], k: number, takeoff: number): number {
  const speed = (a: IgcFix, b: IgcFix) => (b.time > a.time ? distance(a, b) / ((b.time - a.time) / 1000) : 0);
  while (k < fixes.length - 1 && speed(fixes[k]!, fixes[k + 1]!) >= WALK_SPEED) k++;
  const ground = alt(fixes[k]!);
  let i = k;
  while (i > takeoff + 1) {
    const a = fixes[i - 1]!;
    const b = fixes[i]!;
    if (speed(a, b) >= WALK_SPEED) break;
    const h = alt(a);
    if (h !== null && ground !== null && Math.abs(h - ground) > TOUCHDOWN_ALTITUDE) break;
    i--;
  }
  return i;
}

/**
 * Fin de trace au sol, trop courte pour les 60 s d'immobilité : au moins WALK_SECONDS jusqu'au dernier
 * fix, avec les mêmes seuils de déplacement et d'altitude. Renvoie le premier fix de cette fin immobile.
 */
function stillTail(fixes: IgcFix[], from: number): number | null {
  const n = fixes.length;
  const last = fixes[n - 1]!;
  for (let i = from; i < n && last.time - fixes[i]!.time >= WALK_SECONDS * 1000; i++) {
    const a = fixes[i]!;
    let lo = alt(a);
    let hi = lo;
    let ok = true;
    for (let j = i + 1; j < n && ok; j++) {
      const b = fixes[j]!;
      if (distance(a, b) > STILL_DISTANCE) ok = false;
      const h = alt(b);
      if (h !== null && lo !== null && hi !== null) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        if (hi - lo > STILL_ALTITUDE) ok = false;
      }
    }
    if (ok) return i;
  }
  return null;
}

/**
 * Repère le vol dans une trace : décollage au premier déplacement rapide et soutenu, atterrissage
 * à la première immobilité d'au moins 60 s ensuite. Tout ce qui suit (navette, voiture)
 * ne doit plus valider de balise. Une trace qui s'arrête moins de 60 s après le posé est posée si
 * ses 20 dernières secondes au moins sont immobiles. Une trace peut contenir plusieurs vols (redécollage).
 */
export function detectFlights(fixes: IgcFix[]): FlightPeriod[] {
  const n = fixes.length;
  if (n < 2) return [];

  // Pour chaque fix i, j(i) = premier fix au moins STILL_SECONDS plus tard.
  const still = (i: number): boolean | null => {
    const a = fixes[i]!;
    let j = i;
    let maxD = 0;
    let lo = alt(a);
    let hi = lo;
    while (j < n - 1 && fixes[j]!.time - a.time < STILL_SECONDS * 1000) {
      j++;
      const b = fixes[j]!;
      maxD = Math.max(maxD, distance(a, b));
      if (maxD > STILL_DISTANCE) return false;
      const h = alt(b);
      if (h !== null && lo !== null && hi !== null) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        if (hi - lo > STILL_ALTITUDE) return false;
      }
    }
    if (fixes[j]!.time - a.time < STILL_SECONDS * 1000) return null; // fin de trace
    return true;
  };

  const flights: FlightPeriod[] = [];
  let from = 0;
  while (from < n - 1) {
    // Décollage : premier fix suivi de 30 s à plus de 5 m/s en moyenne (on ne marche pas si vite).
    let takeoff = from;
    for (let j = from; takeoff < n - 1; takeoff++) {
      const a = fixes[takeoff]!;
      if (j < takeoff) j = takeoff;
      while (j < n - 1 && fixes[j]!.time - a.time < 30_000) j++;
      if (fixes[j]!.time - a.time >= 30_000 && distance(a, fixes[j]!) > 150) break;
    }
    if (takeoff >= n - 1) break;
    let end: FlightPeriod = { takeoffIndex: takeoff, landingIndex: n - 1, landed: false };
    for (let i = takeoff; i < n; i++) {
      const s = still(i);
      if (s === true) {
        end = { takeoffIndex: takeoff, landingIndex: touchdown(fixes, walkBack(fixes, i, takeoff), takeoff), landed: true };
        break;
      }
      if (s === null) {
        const t = stillTail(fixes, i);
        if (t !== null) end = { takeoffIndex: takeoff, landingIndex: touchdown(fixes, walkBack(fixes, t, takeoff), takeoff), landed: true };
        break;
      }
    }
    flights.push(end);
    if (!end.landed) break;
    from = end.landingIndex + 1;
  }
  return flights;
}
