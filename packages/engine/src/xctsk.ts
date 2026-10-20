import type { ControlZone, Task, TaskTurnpoint, TurnpointRole, Waypoint } from "./task.js";

/**
 * Lecture des manches XCTrack : fichier .xctsk (JSON, version 1) et QR code
 * « XCTSK: » (JSON compact, version 2).
 *
 * Références : go-xctrack (Tom Payne) et pyxctsk. La spécification officielle
 * « XCTrack Competition Interfaces » reste à relire pour les cas limites
 * (longueur de la ligne de goal, rôle du décollage dans le QR code).
 */

export class XctskError extends Error {}

interface V1Waypoint {
  name?: string;
  description?: string;
  lat: number;
  lon: number;
  altSmoothed?: number;
}
interface V1Turnpoint {
  type?: "TAKEOFF" | "SSS" | "ESS" | "";
  radius: number;
  waypoint: V1Waypoint;
}
interface V1Task {
  taskType?: string;
  version?: number;
  earthModel?: "WGS84" | "FAI_SPHERE";
  turnpoints: V1Turnpoint[];
  takeoff?: { timeOpen?: string; timeClose?: string };
  sss?: { type?: "RACE" | "ELAPSED-TIME"; direction?: "ENTER" | "EXIT"; timeGates?: string[] };
  goal?: { type?: "CYLINDER" | "LINE"; deadline?: string };
}

/** "12:45:00Z" ou "\"12:45:00Z\"" -> "12:45:00" (UTC). */
function cleanTime(t: string | undefined): string | undefined {
  if (t === undefined) return undefined;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!m) throw new XctskError(`Heure illisible : ${t}`);
  return `${m[1]!.padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

function buildTask(
  raw: Array<{ type: TurnpointRole | "none"; radius: number; waypoint: Waypoint }>,
  opts: {
    sssType?: "RACE" | "ELAPSED-TIME";
    direction?: "ENTER" | "EXIT";
    gates?: string[];
    goalType?: "CYLINDER" | "LINE";
    deadline?: string;
    takeoffOpen?: string;
    takeoffClose?: string;
    earthModel?: "WGS84" | "FAI_SPHERE";
  },
): Task {
  if (raw.length < 2) throw new XctskError("Une manche doit compter au moins deux balises.");
  const lastIndex = raw.length - 1;

  // Sans SSS (tâche saisie sans départ, distance libre) : le départ est la première balise après le
  // décollage, comme pour une manche où l'on part dès le décollage.
  if (!raw.some((x) => x.type === "sss") && raw.length >= 2) {
    const first = raw[0]!.type === "takeoff" || (raw[0]!.type === "none" && raw.length > 2) ? 1 : 0;
    if (first < lastIndex && raw[first]!.type === "none") {
      raw = raw.map((x, i) => (i === 0 && first === 1 && x.type === "none" ? { ...x, type: "takeoff" as const } : i === first ? { ...x, type: "sss" as const } : x));
    } else if (raw[0]!.type === "takeoff" && raw[0]!.radius > 0) {
      // Pas de balise libre avant l'ESS ou le goal : le cylindre du décollage sert de départ.
      raw = raw.map((x, i) => (i === 0 ? { ...x, type: "sss" as const } : x));
    }
  }
  const turnpoints: TaskTurnpoint[] = raw.map((r, i) => {
    let role: TurnpointRole;
    if (i === lastIndex) role = "goal";
    // Le QR code ne type pas le décollage : un premier point sans rôle, placé avant le départ, est le décollage.
    else if (i === 0 && r.type === "none" && raw.slice(1).some((x) => x.type === "sss")) role = "takeoff";
    else if (r.type === "none") role = "turnpoint";
    else role = r.type;

    let zone: ControlZone;
    if (role === "goal" && opts.goalType === "LINE") {
      // XCTrack porte la demi-longueur de la ligne dans le rayon (à confirmer sur la spécification).
      zone = { kind: "goal-line", waypoint: r.waypoint, length: 2 * r.radius };
    } else {
      zone = { kind: "cylinder", waypoint: r.waypoint, radius: r.radius };
    }
    return { role, zone };
  });

  if (!turnpoints.some((t) => t.role === "sss")) {
    throw new XctskError("La manche n'a pas de départ (SSS).");
  }

  const task: Task = {
    type: opts.sssType === "ELAPSED-TIME" ? "time-trial" : "race",
    turnpoints,
    startGates: (opts.gates ?? []).map((g) => cleanTime(g)!),
  };
  const deadline = cleanTime(opts.deadline);
  if (deadline) task.deadline = deadline;
  const to = cleanTime(opts.takeoffOpen);
  if (to) task.takeoffOpen = to;
  const tc = cleanTime(opts.takeoffClose);
  if (tc) task.takeoffClose = tc;
  if (opts.direction) task.startDirection = opts.direction === "EXIT" ? "exit" : "enter";
  if (opts.earthModel) task.sourceEarthModel = opts.earthModel;
  return task;
}

function v1Role(t: V1Turnpoint["type"]): TurnpointRole | "none" {
  if (t === "TAKEOFF") return "takeoff";
  if (t === "SSS") return "sss";
  if (t === "ESS") return "ess";
  return "none";
}

/** Lit un fichier .xctsk (JSON version 1). */
export function parseXctskV1(json: string | V1Task): Task {
  const data: V1Task = typeof json === "string" ? (JSON.parse(json) as V1Task) : json;
  if (!Array.isArray(data.turnpoints)) throw new XctskError("Champ « turnpoints » absent.");
  const raw = data.turnpoints.map((tp) => {
    const wp: Waypoint = { name: tp.waypoint.name ?? "", lat: tp.waypoint.lat, lon: tp.waypoint.lon };
    if (tp.waypoint.description) wp.description = tp.waypoint.description;
    if (tp.waypoint.altSmoothed !== undefined) wp.altitude = tp.waypoint.altSmoothed;
    return { type: v1Role(tp.type), radius: tp.radius, waypoint: wp };
  });
  const opts: Parameters<typeof buildTask>[1] = {};
  if (data.sss?.type) opts.sssType = data.sss.type;
  if (data.sss?.direction) opts.direction = data.sss.direction;
  if (data.sss?.timeGates) opts.gates = data.sss.timeGates;
  if (data.goal?.type) opts.goalType = data.goal.type;
  if (data.goal?.deadline) opts.deadline = data.goal.deadline;
  if (data.takeoff?.timeOpen) opts.takeoffOpen = data.takeoff.timeOpen;
  if (data.takeoff?.timeClose) opts.takeoffClose = data.takeoff.timeClose;
  if (data.earthModel) opts.earthModel = data.earthModel;
  return buildTask(raw, opts);
}

// ---------------------------------------------------------------------------
// QR code (version 2)

/** Décode une suite d'entiers signés au format « polyline » de Google. */
export function decodePolylineInts(s: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (i >= s.length) throw new XctskError("Coordonnées QR tronquées.");
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    out.push(result & 1 ? ~(result >> 1) : result >> 1);
  }
  return out;
}

/** Encode une suite d'entiers signés au format « polyline » (utile aux tests et à l'export). */
export function encodePolylineInts(values: number[]): string {
  let s = "";
  for (const v0 of values) {
    let v = v0 < 0 ? ~(v0 << 1) : v0 << 1;
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    s += String.fromCharCode(v + 63);
  }
  return s;
}

interface V2Task {
  taskType?: string;
  version?: number;
  t: Array<{ z: string; n?: string; d?: string; t?: number }>;
  s?: { g?: string[]; d?: number; t?: number };
  g?: { d?: string; t?: number };
  e?: number;
  to?: string;
  tc?: string;
}

function v2Role(t: number | undefined): TurnpointRole | "none" {
  // go-xctrack : 0 = aucun, 2 = SSS, 3 = ESS ; 1 supposé décollage.
  if (t === 1) return "takeoff";
  if (t === 2) return "sss";
  if (t === 3) return "ess";
  return "none";
}

/** Lit le contenu texte d'un QR code XCTrack (« XCTSK:{...} »). */
export function parseXctskQr(text: string): Task {
  const trimmed = text.trim();
  if (trimmed.startsWith("XCTSKZ:")) {
    throw new XctskError("Le format compressé XCTSKZ n'est pas encore pris en charge.");
  }
  const body = trimmed.startsWith("XCTSK:") ? trimmed.slice("XCTSK:".length) : trimmed;
  const data = JSON.parse(body) as V2Task;
  if (!Array.isArray(data.t)) throw new XctskError("Champ « t » (balises) absent.");
  const raw = data.t.map((tp) => {
    const [lon, lat, alt, radius] = decodePolylineInts(tp.z);
    if (lon === undefined || lat === undefined || radius === undefined) {
      throw new XctskError(`Balise ${tp.n ?? "?"} : coordonnées incomplètes.`);
    }
    const wp: Waypoint = { name: tp.n ?? "", lat: lat / 1e5, lon: lon / 1e5 };
    if (alt !== undefined) wp.altitude = alt;
    if (tp.d) wp.description = tp.d;
    return { type: v2Role(tp.t), radius, waypoint: wp };
  });
  const opts: Parameters<typeof buildTask>[1] = {};
  if (data.s?.t !== undefined) opts.sssType = data.s.t === 2 ? "ELAPSED-TIME" : "RACE";
  if (data.s?.d !== undefined) opts.direction = data.s.d === 2 ? "EXIT" : "ENTER";
  if (data.s?.g) opts.gates = data.s.g;
  if (data.g?.t !== undefined) opts.goalType = data.g.t === 1 ? "LINE" : "CYLINDER";
  if (data.g?.d) opts.deadline = data.g.d;
  if (data.to) opts.takeoffOpen = data.to;
  if (data.tc) opts.takeoffClose = data.tc;
  if (data.e !== undefined) opts.earthModel = data.e === 1 ? "FAI_SPHERE" : "WGS84";
  return buildTask(raw, opts);
}

/** Choisit le bon lecteur selon le contenu (fichier .xctsk ou texte de QR code). */
export function parseXctsk(text: string): Task {
  const t = text.trim();
  if (t.startsWith("XCTSK")) return parseXctskQr(t);
  const data = JSON.parse(t) as { version?: number; t?: unknown };
  if (data.version === 2 || Array.isArray(data.t)) return parseXctskQr(t);
  return parseXctskV1(t);
}

/** Manche → texte de QR code XCTrack (« XCTSK: », version 2), relu à l'identique par parseXctskQr. */
export function taskToXctskQr(task: Task): string {
  const z = (tp: TaskTurnpoint) => {
    const w = tp.zone.waypoint;
    const radius = tp.zone.kind === "goal-line" ? tp.zone.length / 2 : tp.zone.radius;
    return encodePolylineInts([Math.round(w.lon * 1e5), Math.round(w.lat * 1e5), Math.round(w.altitude ?? 0), Math.round(radius)]);
  };
  const utc = (t: string) => `${t}Z`;
  const goal = task.turnpoints[task.turnpoints.length - 1]!;
  const data: V2Task = {
    version: 2,
    taskType: "CLASSIC",
    // Le décollage n'est pas typé dans le QR code : XCTrack le reconnaît comme premier point avant le SSS.
    t: task.turnpoints.map((tp) => ({
      z: z(tp),
      n: tp.zone.waypoint.name,
      ...(tp.zone.waypoint.description ? { d: tp.zone.waypoint.description } : {}),
      ...(tp.role === "sss" ? { t: 2 } : tp.role === "ess" ? { t: 3 } : {}),
    })),
    s: { g: task.startGates.map(utc), d: task.startDirection === "enter" ? 1 : 2, t: task.type === "time-trial" ? 2 : 1 },
    g: { ...(task.deadline ? { d: utc(task.deadline) } : {}), t: goal.zone.kind === "goal-line" ? 1 : 2 },
  };
  if (task.sourceEarthModel === "FAI_SPHERE") data.e = 1;
  if (task.takeoffOpen) data.to = utc(task.takeoffOpen);
  if (task.takeoffClose) data.tc = utc(task.takeoffClose);
  return `XCTSK:${JSON.stringify(data)}`;
}
