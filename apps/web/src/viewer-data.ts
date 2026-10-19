import {
  airspaceInfringements,
  controlFlight,
  direct,
  distance,
  inverse,
  limitAmsl,
  parseIgc,
  parseOpenAir,
  taskDistances,
  zoneApproaches,
  type LatLon,
  type Task,
} from "@pgscore/engine";
import type { CompetitionSettings } from "./settings.js";

/**
 * Données de la vue d'une trace : zones de la manche, route optimisée, espaces aériens proches,
 * points de la trace avec la distance au bord de la prochaine zone à valider, validations,
 * passages au plus près et infractions. Tout est calculé côté serveur, sur l'ellipsoïde WGS84,
 * pour que les distances affichées soient celles du contrôle.
 */

export interface ViewerData {
  pilot: { key: string; name: string };
  timeZone: string;
  date: string | null;
  zones: Array<{
    index: number;
    name: string;
    role: string;
    lat: number;
    lon: number;
    altitude: number | null;
    radius: number;
    /** Ligne de goal : extrémités et demi-cercle arrière. */
    line?: { a: LatLon; b: LatLon; semicircle: LatLon[] };
  }>;
  route: LatLon[];
  gates: number[];
  deadline: number | null;
  airspaces: Array<{ name: string; class: string; lower: number; upper: number; lowerText: string; upperText: string; polygon: LatLon[] }>;
  /** Versions de la trace du pilote, celle en vigueur d'abord. */
  versions: VersionData[];
}

export interface VersionMeta {
  sha256: string;
  filename: string;
  uploadedAt: number;
  uploadedBy: string | null;
  status: "current" | "replaced" | "removed";
  endedAt: number | null;
  endedBy: string | null;
  note: string | null;
}

export interface VersionData extends VersionMeta {
  stopTime: number | null;
  track: {
    t: number[];
    lat: number[];
    lon: number[];
    alt: Array<number | null>;
    /** Index (dans la trace) de la prochaine zone à valider, et distance à son bord (m, positive dehors). */
    next: number[];
    edge: Array<number | null>;
    flightStart: number;
    flightEnd: number;
  };
  validations: Array<{ index: number; name: string; role: string; time: number; altitude: number | null }>;
  approaches: ReturnType<typeof zoneApproaches>;
  infringements: Array<{ name: string; class: string; depth: number; verticalDepth: number; from: number; to: number; worst: number }>;
  result: { madeGoal: boolean; madeEss: boolean; flownDistance: number; taskDistance: number; startTime: number | null; essTime: number | null; goalTime: number | null };
}

function goalLine(centre: LatLon, from: LatLon, length: number) {
  // Ligne perpendiculaire à la route qui arrive au goal ; demi-cercle du côté opposé à l'arrivée (S7F 6.2.3.1).
  const az = inverse(centre, from).azimuth1;
  const half = length / 2;
  const a = direct(centre, az - 90, half);
  const b = direct(centre, az + 90, half);
  const semicircle: LatLon[] = [];
  for (let k = 0; k <= 36; k++) {
    const p = direct(centre, az + 90 + (180 * k) / 36, half);
    semicircle.push({ lat: p.lat, lon: p.lon });
  }
  return { a: { lat: a.lat, lon: a.lon }, b: { lat: b.lat, lon: b.lon }, semicircle };
}

const hms = (s: string, day: number) => {
  const [h, m, x] = s.split(":").map(Number);
  return day + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (x ?? 0)) * 1000;
};

/** Dessin de la manche : zones (avec la ligne de goal) et route optimisée, avec la longueur de chaque branche. */
export function taskGeometry(task: Task): { zones: ViewerData["zones"]; route: LatLon[]; legs: number[]; distance: number } {
  const dist = taskDistances(task);
  const zones: ViewerData["zones"] = task.turnpoints.map((tp, i) => {
    const w = tp.zone.waypoint;
    const z: ViewerData["zones"][number] = {
      index: i,
      name: w.name,
      role: tp.role,
      lat: w.lat,
      lon: w.lon,
      altitude: w.altitude ?? null,
      radius: tp.zone.kind === "cylinder" ? tp.zone.radius : tp.zone.length / 2,
    };
    if (tp.zone.kind === "goal-line") z.line = goalLine(w, dist.route.points[i - 1] ?? w, tp.zone.length);
    return z;
  });
  const legs = dist.route.points.slice(1).map((p, i) => distance(dist.route.points[i]!, p));
  return { zones, route: dist.route.points, legs, distance: dist.task };
}

export function viewerData(
  task: Task,
  versions: Array<{ igc: string; meta: VersionMeta }>,
  airspaceText: string | null,
  settings: CompetitionSettings,
  pilot: { key: string; name: string | null },
  date: string | null,
): ViewerData {
  if (!versions.length) throw new Error("Aucune trace pour ce pilote.");
  const dist = taskDistances(task);
  const tps = task.turnpoints;
  const flights = versions.map((v) => ({ meta: v.meta, flight: parseIgc(v.igc) }));
  const firstFix = flights.flatMap((f) => f.flight.fixes.slice(0, 1))[0];
  const day = firstFix ? Math.floor(firstFix.time / 86_400_000) * 86_400_000 : 0;

  const { zones } = taskGeometry(task);

  // Espaces aériens à moins de 30 km de la manche ou des traces.
  const box = (() => {
    const pts: LatLon[] = [...zones, ...flights.flatMap((f) => f.flight.fixes.filter((x, i) => x.valid && i % 30 === 0))];
    const m = 0.3;
    return {
      s: Math.min(...pts.map((p) => p.lat)) - m,
      n: Math.max(...pts.map((p) => p.lat)) + m,
      w: Math.min(...pts.map((p) => p.lon)) - m,
      e: Math.max(...pts.map((p) => p.lon)) + m,
    };
  })();
  const all = airspaceText ? parseOpenAir(airspaceText) : [];
  const round = (x: number | null) => (x !== null && settings.roundAirspaceLimits && Number.isFinite(x) ? Math.round(x) : x);
  const airspaces: ViewerData["airspaces"] = [];
  for (const a of all) {
    const lo = round(limitAmsl(a.lower));
    const hi = round(limitAmsl(a.upper));
    if (lo === null || hi === null) continue;
    if (!a.polygon.some((p) => p.lat >= box.s && p.lat <= box.n && p.lon >= box.w && p.lon <= box.e)) continue;
    airspaces.push({ name: a.name, class: a.class, lower: Math.max(lo, -1000), upper: Math.min(hi, 20000), lowerText: a.lowerText, upperText: a.upperText, polygon: a.polygon });
  }

  const sssIdx = tps.findIndex((t) => t.role === "sss");
  const analyse = (meta: VersionMeta, flight: ReturnType<typeof parseIgc>): VersionData => {
    const fixes = flight.fixes.filter((f) => f.valid);
    const c = controlFlight(task, flight.fixes);
    // Prochaine zone à valider et distance à son bord, fix par fix.
    const steps = c.validated.map((v) => ({ time: v.time, next: v.index + 1 }));
    const next: number[] = [];
    const edge: Array<number | null> = [];
    for (const f of fixes) {
      let n = sssIdx;
      for (const st of steps) if (st.time <= f.time) n = st.next;
      next.push(n);
      const z = zones[n];
      edge.push(z ? Math.round((distance(z, f) - z.radius) * 10) / 10 : null);
    }
    const flightStart = c.inFlight.length ? fixes.indexOf(c.inFlight[0]!) : 0;
    const flightEnd = c.inFlight.length ? fixes.indexOf(c.inFlight.at(-1)!) : fixes.length - 1;
    const inf = airspaceInfringements(all, c.inFlight, { roundLimitsToMetre: settings.roundAirspaceLimits });
    return {
      ...meta,
      stopTime: c.stopped?.taskStopTime ?? null,
      track: {
        t: fixes.map((f) => f.time),
        lat: fixes.map((f) => Math.round(f.lat * 1e6) / 1e6),
        lon: fixes.map((f) => Math.round(f.lon * 1e6) / 1e6),
        alt: fixes.map((f) => f.gnssAltitude ?? f.pressureAltitude),
        next,
        edge,
        flightStart: Math.max(0, flightStart),
        flightEnd: Math.max(0, flightEnd),
      },
      validations: c.validated.map((v) => ({ index: v.index, name: v.name, role: v.role, time: v.time, altitude: v.altitude })),
      approaches: zoneApproaches(task, c),
      infringements: inf.map((i) => ({
        name: i.airspace.name,
        class: i.airspace.class,
        depth: i.depth,
        verticalDepth: i.verticalDepth,
        from: i.from,
        to: i.to,
        worst: i.worst.time,
      })),
      result: {
        madeGoal: c.madeGoal,
        madeEss: c.madeEss,
        flownDistance: c.flownDistance,
        taskDistance: dist.task,
        startTime: c.startTime,
        essTime: c.essTime,
        goalTime: c.goalTime,
      },
    };
  };

  return {
    pilot: { key: pilot.key, name: pilot.name ?? flights[0]!.flight.header.pilot ?? pilot.key },
    timeZone: settings.timeZone,
    date,
    zones,
    route: dist.route.points,
    gates: task.startGates.map((g) => hms(g, day)),
    deadline: task.deadline ? hms(task.deadline, day) : null,
    airspaces,
    versions: flights.map((f) => analyse(f.meta, f.flight)),
  };
}
