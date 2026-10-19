import { direct, inverse, type LatLon } from "./geo.js";
import type { IgcFix } from "./igc.js";

/**
 * Lecture des espaces aériens au format OpenAir et contrôle des infractions.
 *
 * Règles du projet :
 * - les limites sont comparées à l'altitude GNSS, en AMSL ; les limites AGL ne sont pas gérées ;
 * - un niveau de vol est converti à 1013,25 hPa (FL × 100 ft), puis abaissé de 100 m
 *   pour couvrir l'écart entre altitude GNSS et altitude pression.
 */

export type AltitudeLimit =
  | { kind: "sfc" }
  | { kind: "unl" }
  | { kind: "amsl"; meters: number }
  | { kind: "fl"; level: number }
  | { kind: "agl"; meters: number };

export interface Airspace {
  name: string;
  /** Classe OpenAir (A, B, C, D, E, R, P, Q, CTR, TMZ…). */
  class: string;
  lower: AltitudeLimit;
  upper: AltitudeLimit;
  /** Contour fermé (le dernier point n'est pas répété). */
  polygon: LatLon[];
  /** Texte d'origine des limites, pour l'affichage. */
  lowerText: string;
  upperText: string;
}

const FT = 0.3048;
/** Marge appliquée aux niveaux de vol, en mètres. */
export const FLIGHT_LEVEL_MARGIN = 100;
const NM = 1852;
/** Pas angulaire des arcs et des cercles, en degrés. */
const ARC_STEP = 2;

export class OpenAirError extends Error {}

/** Limite convertie en mètres AMSL ; null pour une limite AGL (non gérée). */
export function limitAmsl(l: AltitudeLimit): number | null {
  switch (l.kind) {
    case "sfc":
      return -Infinity;
    case "unl":
      return Infinity;
    case "amsl":
      return l.meters;
    case "fl":
      return l.level * 100 * FT - FLIGHT_LEVEL_MARGIN;
    case "agl":
      return null;
  }
}

export function parseAltitude(text: string): AltitudeLimit {
  const t = text.trim().toUpperCase().replace(/\s+/g, " ");
  if (/^(SFC|GND|SURFACE|0)$/.test(t) || /^0 ?(FT|M)?( ?(AMSL|MSL|AGL|GND|SFC))?$/.test(t)) return { kind: "sfc" };
  if (/^(UNL|UNLIM|UNLIMITED)/.test(t)) return { kind: "unl" };
  const fl = /^FL ?(\d+(?:\.\d+)?)/.exec(t);
  if (fl) return { kind: "fl", level: Number(fl[1]) };
  const m = /^(\d+(?:\.\d+)?) ?(FT|F|M)?\b ?(.*)$/.exec(t);
  if (!m) throw new OpenAirError(`Altitude illisible : « ${text} »`);
  const meters = Number(m[1]) * (m[2] === "M" ? 1 : FT);
  const ref = m[3] ?? "";
  if (/AGL|GND|SFC|ASFC/.test(ref)) return { kind: "agl", meters };
  return { kind: "amsl", meters };
}

/** Coordonnée OpenAir : "46:16:30 N 013:10:20 E", "46:16.5N 13:10.3E", "46.275 N 13.172 E". */
export function parseCoordinate(text: string): LatLon {
  const re = /(\d+(?:[.,]\d+)?)(?::(\d+(?:[.,]\d+)?))?(?::(\d+(?:[.,]\d+)?))?\s*([NSEW])/gi;
  const parts = [...text.matchAll(re)];
  if (parts.length !== 2) throw new OpenAirError(`Coordonnée illisible : « ${text} »`);
  const val = (p: RegExpMatchArray) => {
    const n = (s?: string) => (s ? Number(s.replace(",", ".")) : 0);
    const v = n(p[1]) + n(p[2]) / 60 + n(p[3]) / 3600;
    return /[SW]/i.test(p[4]!) ? -v : v;
  };
  const [a, b] = parts as [RegExpMatchArray, RegExpMatchArray];
  const aIsLat = /[NS]/i.test(a[4]!);
  return aIsLat ? { lat: val(a), lon: val(b) } : { lat: val(b), lon: val(a) };
}

function arcPoints(centre: LatLon, radius: number, from: number, to: number, clockwise: boolean): LatLon[] {
  const norm = (x: number) => ((x % 360) + 360) % 360;
  let sweep = clockwise ? norm(to - from) : -norm(from - to);
  if (sweep === 0) sweep = clockwise ? 360 : -360;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const pts: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const p = direct(centre, from + (sweep * i) / n, radius);
    pts.push({ lat: p.lat, lon: p.lon });
  }
  return pts;
}

/** Lit un fichier OpenAir. Les lignes inconnues (AT, AY, SP, SB…) sont ignorées. */
export function parseOpenAir(source: string): Airspace[] {
  const out: Airspace[] = [];
  let cur: (Partial<Airspace> & { polygon: LatLon[] }) | null = null;
  let centre: LatLon | null = null;
  let clockwise = true;

  const flush = () => {
    if (cur && cur.polygon.length >= 3 && cur.lower && cur.upper) {
      const p = cur.polygon;
      const f = p[0]!;
      const l = p.at(-1)!;
      if (Math.abs(f.lat - l.lat) < 1e-9 && Math.abs(f.lon - l.lon) < 1e-9) p.pop();
      out.push({
        name: cur.name ?? "",
        class: cur.class ?? "",
        lower: cur.lower,
        upper: cur.upper,
        polygon: p,
        lowerText: cur.lowerText ?? "",
        upperText: cur.upperText ?? "",
      });
    }
    cur = null;
    centre = null;
    clockwise = true;
  };

  source.split(/\r?\n/).forEach((raw, lineNo) => {
    const line = raw.replace(/\*.*$/, "").trim();
    if (!line) return;
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    const key = cmd!.toUpperCase();
    try {
      if (key === "AC") {
        flush();
        cur = { class: arg.toUpperCase(), polygon: [] };
        return;
      }
      if (!cur) return;
      const c: Partial<Airspace> & { polygon: LatLon[] } = cur;
      switch (key) {
        case "AN":
          c.name = arg;
          break;
        case "AL":
          c.lower = parseAltitude(arg);
          c.lowerText = arg;
          break;
        case "AH":
          c.upper = parseAltitude(arg);
          c.upperText = arg;
          break;
        case "DP":
          c.polygon.push(parseCoordinate(arg));
          break;
        case "V": {
          const [k, v] = arg.split("=").map((s) => s.trim());
          if (k?.toUpperCase() === "X") centre = parseCoordinate(v ?? "");
          else if (k?.toUpperCase() === "D") clockwise = v !== "-";
          break;
        }
        case "DC": {
          if (!centre) throw new OpenAirError("DC sans centre (V X=)");
          c.polygon.push(...arcPoints(centre, Number(arg.replace(",", ".")) * NM, 0, 360, true).slice(0, -1));
          break;
        }
        case "DA": {
          if (!centre) throw new OpenAirError("DA sans centre (V X=)");
          const [r, a1, a2] = arg.split(",").map((s) => Number(s.trim()));
          c.polygon.push(...arcPoints(centre, r! * NM, a1!, a2!, clockwise));
          break;
        }
        case "DB": {
          if (!centre) throw new OpenAirError("DB sans centre (V X=)");
          const [p1, p2] = arg.split(",").map((s) => parseCoordinate(s));
          const i1 = inverse(centre, p1!);
          const i2 = inverse(centre, p2!);
          c.polygon.push(p1!, ...arcPoints(centre, i1.distance, i1.azimuth1, i2.azimuth1, clockwise).slice(1, -1), p2!);
          break;
        }
      }
    } catch (e) {
      throw new OpenAirError(`Ligne ${lineNo + 1} : ${(e as Error).message}`);
    }
  });
  flush();
  return out;
}

/** Plan local équirectangulaire autour d'un point (m) : suffisant à l'échelle d'un espace aérien. */
function toLocal(origin: LatLon) {
  const R = 6_371_008.8;
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return (p: LatLon) => ({
    x: (((p.lon - origin.lon + 540) % 360) - 180) * (Math.PI / 180) * R * k,
    y: (p.lat - origin.lat) * (Math.PI / 180) * R,
  });
}

/** Position horizontale d'un point par rapport au contour : dedans, et distance au bord (m). */
export function horizontalPosition(a: Airspace, p: LatLon): { inside: boolean; edgeDistance: number } {
  const proj = toLocal(p);
  const pts = a.polygon.map(proj);
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const A = pts[j]!;
    const B = pts[i]!;
    if (A.y > 0 !== B.y > 0 && 0 < ((B.x - A.x) * (0 - A.y)) / (B.y - A.y) + A.x) inside = !inside;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / len2));
    best = Math.min(best, Math.hypot(A.x + t * dx, A.y + t * dy));
  }
  return { inside, edgeDistance: best };
}

export interface AirspaceInfringement {
  airspace: Airspace;
  /** Première et dernière seconde dans l'espace, ms UTC. */
  from: number;
  to: number;
  /** Pénétration maximale (m) : distance la plus courte pour ressortir, par le dessus, le dessous ou le côté. */
  depth: number;
  /** Pénétration verticale maximale (m), la plus utile pour un plancher ou un plafond. */
  verticalDepth: number;
  /** Fix de pénétration maximale. */
  worst: IgcFix;
}

/**
 * Infractions d'une trace : fixes à l'intérieur du contour et entre les limites (AMSL, GNSS).
 * Les espaces à limite AGL sont ignorés. Une infraction est retournée par espace et par passage.
 */
export interface InfringementOptions {
  /**
   * Arrondit au mètre les limites converties (pieds → mètres), comme SVL (PWCA) :
   * 1000 ft donne 305 m et non 304,8 m. Retrouvé sur Gemona 2026, manche 3.
   */
  roundLimitsToMetre?: boolean;
}

export function airspaceInfringements(
  airspaces: Airspace[],
  fixes: IgcFix[],
  options: InfringementOptions = {},
): AirspaceInfringement[] {
  const out: AirspaceInfringement[] = [];
  const round = (x: number | null) => (x !== null && options.roundLimitsToMetre && Number.isFinite(x) ? Math.round(x) : x);
  for (const a of airspaces) {
    const lo = round(limitAmsl(a.lower));
    const hi = round(limitAmsl(a.upper));
    if (lo === null || hi === null) continue;
    const box = bbox(a.polygon);
    let open: AirspaceInfringement | null = null;
    for (const f of fixes) {
      const z = f.gnssAltitude ?? f.pressureAltitude;
      let inside = false;
      let depth = 0;
      let vDepth = 0;
      if (z !== null && z > lo && z < hi && f.lat >= box.s && f.lat <= box.n && f.lon >= box.w && f.lon <= box.e) {
        const h = horizontalPosition(a, f);
        if (h.inside) {
          inside = true;
          vDepth = Math.min(z - lo, hi - z);
          depth = Math.min(vDepth, h.edgeDistance);
        }
      }
      if (inside) {
        if (!open) {
          open = { airspace: a, from: f.time, to: f.time, depth, verticalDepth: vDepth, worst: f };
          out.push(open);
        }
        open.to = f.time;
        if (depth > open.depth) {
          open.depth = depth;
          open.worst = f;
        }
        open.verticalDepth = Math.max(open.verticalDepth, vDepth);
      } else open = null;
    }
  }
  return out.sort((x, y) => x.from - y.from);
}

function bbox(p: LatLon[]) {
  // Marge d'environ 1 km pour les contours tracés en arcs.
  const m = 0.01;
  return {
    s: Math.min(...p.map((q) => q.lat)) - m,
    n: Math.max(...p.map((q) => q.lat)) + m,
    w: Math.min(...p.map((q) => q.lon)) - m,
    e: Math.max(...p.map((q) => q.lon)) + m,
  };
}

/**
 * Pénalité d'espace aérien en points (règlement PWCA 2026, annexe « Airspace Penalties ») :
 * 1000 · min(1, (1,05^profondeur − 1) / (1,05^f − 1)). La pénalité atteint 1000 points à f mètres :
 * f = 50 pour un espace réglementaire (« hard »), f = 100 pour un espace de compétition ou le vol
 * dans les nuages (« soft »).
 */
export function airspacePenalty(depth: number, fullPenaltyDepth: number): number {
  if (depth <= 0) return 0;
  return 1000 * Math.min(1, (1.05 ** depth - 1) / (1.05 ** fullPenaltyDepth - 1));
}

/**
 * Pénalité d'espace aérien du S7A 2026 (6.3.1), épreuves FAI : proportion des points du pilote,
 * linéaire de 0 à 100 % entre 0 et 100 m de pénétration, verticale ou horizontale. L'espace de
 * compétition doit déjà inclure une marge d'au moins 100 m autour des zones interdites.
 */
export function airspacePenaltyFractionS7A(depth: number): number {
  return Math.max(0, Math.min(1, depth / 100));
}
