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
  // Seule la distance est demandée : GeographicLib saute azimuts et longueurs réduites.
  const r = wgs84.Inverse(a.lat, a.lon, b.lat, b.lon, Geodesic.DISTANCE);
  return r.s12 ?? 0;
}

const RAD = Math.PI / 180;
/** Rayon moyen de la Terre (m), pour l'estimation sphérique. */
const MEAN_RADIUS = 6_371_008.8;
/**
 * Écart relatif maximal entre la distance sphérique (rayon moyen) et la distance WGS84, avec marge :
 * l'aplatissement de l'ellipsoïde limite l'écart à environ 0,56 %.
 */
export const SPHERICAL_TOLERANCE = 0.007;

/**
 * Distance approchée sur la sphère (haversine), beaucoup plus rapide que la géodésique.
 * Ne sert qu'à écarter les cas certains : la distance WGS84 est à moins de SPHERICAL_TOLERANCE près.
 */
export function sphericalDistance(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * MEAN_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
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
