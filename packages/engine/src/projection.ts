import proj4 from "proj4";
import type { LatLon } from "./geo.js";

/** Point cartésien (mètres) dans la projection locale de la manche. */
export interface XY {
  x: number;
  y: number;
}

interface Converter {
  forward(c: number[]): number[];
  inverse(c: number[]): number[];
}

/**
 * Projection transverse de Mercator locale (LTM), centrée sur la manche
 * (S7F 2026, 7.1.2 et annexe A.1). Facteur d'échelle 0,99994, augmenté au-delà de 55° de latitude.
 */
export class LocalProjection {
  private readonly converter: Converter;

  constructor(readonly centre: LatLon) {
    const la = Math.abs(centre.lat);
    const k0 = la <= 55 ? 0.99994 : 0.99994 + ((la - 55) / 60) * 1.3e-4;
    // etmerc = transverse Mercator étendue (séries de Poder/Engsager), précise loin du méridien central.
    const def = `+proj=etmerc +lat_0=${centre.lat} +lon_0=${centre.lon} +k_0=${k0.toFixed(10)} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`;
    this.converter = proj4("EPSG:4326", def) as unknown as Converter;
  }

  toXY(p: LatLon): XY {
    const [x, y] = this.converter.forward([p.lon, p.lat]);
    return { x: x!, y: y! };
  }

  toLatLon(p: XY): LatLon {
    const [lon, lat] = this.converter.inverse([p.x, p.y]);
    return { lat: lat!, lon: lon! };
  }
}

/**
 * Centre de la zone de la manche (S7F 7.1.6) : centre de la boîte englobante des points,
 * en tenant compte d'un éventuel passage de l'antiméridien.
 */
export function findTaskAreaCentre(points: LatLon[]): LatLon {
  if (points.length === 0) throw new Error("Aucun point pour calculer le centre de la manche.");
  const lats = points.map((p) => p.lat);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const lons = points.map((p) => ((((p.lon + 180) % 360) + 360) % 360) - 180).sort((a, b) => a - b);
  // Plus grand trou entre longitudes voisines, y compris celui qui « fait le tour ».
  let maxGap = lons[0]! + 360 - lons.at(-1)!;
  let west = lons[0]!;
  let east = lons.at(-1)!;
  for (let i = 1; i < lons.length; i++) {
    const gap = lons[i]! - lons[i - 1]!;
    if (gap > maxGap) {
      maxGap = gap;
      west = lons[i]!;
      east = lons[i - 1]!;
    }
  }
  let lon: number;
  if (west <= east) lon = (west + east) / 2;
  else {
    lon = ((west + east + 360) / 2) % 360;
    if (lon > 180) lon -= 360;
  }
  return { lat: (minLat + maxLat) / 2, lon };
}
