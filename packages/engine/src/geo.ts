import geographiclib from "geographiclib-geodesic";

// Le paquet est publié en CommonJS : on passe par l'export par défaut pour Node comme pour les bundlers.
const { Geodesic } = geographiclib;

/** Point WGS84 en degrés décimaux. */
export interface LatLon {
  lat: number;
  lon: number;
}

const wgs84 = Geodesic.WGS84;

/**
 * Distance horizontale sur l'ellipsoïde WGS84, en mètres (S7F 2026, 4.2 et 7.1.5 :
 * InverseGeodesic de Karney, via GeographicLib).
 */
export function distance(a: LatLon, b: LatLon): number {
  const r = wgs84.Inverse(a.lat, a.lon, b.lat, b.lon);
  return r.s12 ?? 0;
}

/** Distance et azimuts aller/arrivée (S7F 7.1.4, InverseGeodesic). */
export function inverse(a: LatLon, b: LatLon): { distance: number; azimuth1: number; azimuth2: number } {
  const r = wgs84.Inverse(a.lat, a.lon, b.lat, b.lon);
  return { distance: r.s12 ?? 0, azimuth1: r.azi1 ?? 0, azimuth2: r.azi2 ?? 0 };
}

/** Point à une distance (m) et un azimut (degrés) donnés (S7F 7.1.4, DirectGeodesic). */
export function direct(a: LatLon, azimuth: number, dist: number): LatLon & { azimuth2: number } {
  const r = wgs84.Direct(a.lat, a.lon, azimuth, dist);
  return { lat: r.lat2 ?? a.lat, lon: r.lon2 ?? a.lon, azimuth2: r.azi2 ?? azimuth };
}
