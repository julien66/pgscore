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

/**
 * Repère le vol dans une trace : décollage au premier déplacement rapide et soutenu, atterrissage
 * à la première immobilité d'au moins 60 s ensuite. Tout ce qui suit (navette, voiture)
 * ne doit plus valider de balise. Une trace peut contenir plusieurs vols (redécollage).
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
        end = { takeoffIndex: takeoff, landingIndex: i, landed: true };
        break;
      }
      if (s === null) break;
    }
    flights.push(end);
    if (!end.landed) break;
    from = end.landingIndex + 1;
  }
  return flights;
}
