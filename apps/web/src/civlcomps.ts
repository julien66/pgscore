import { ZipReader } from "./zip.js";
import { createHash } from "node:crypto";
import { controlFlight, goalAltitudeFactor, parseIgc, taskDistances, type TaskTurnpoint } from "@pgscore/engine";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, type ArchiveFile, type ArchiveTask, type CompetitionArchive } from "./archive.js";
import { t } from "./i18n.js";
import { cleanPilot, splitBrand, type PilotFields } from "./pilots.js";
import { DEFAULT_SETTINGS, FormError, type CompetitionSettings, type StoredTask } from "./settings.js";
import type { TrackStore } from "./track-store.js";
import { decodeEntities, decodeFsName } from "./text.js";
import { offsetMinutes } from "./time.js";
import tzLookup from "@photostructure/tz-lookup";

/**
 * Import d'une compétition publiée sur civlcomps.org, à partir de l'adresse de sa page de résultats
 * (https://civlcomps.org/event/<nom>/results).
 *
 * La page liste les manches avec, pour chacune, le ZIP des traces IGC et les résultats de FS. La page de
 * résultats d'une manche reprend la sortie HTML de FS : définition de la manche (balises, rayons, heures
 * locales), arrêt éventuel, pénalités, statistiques et réglages de la formule, et la liste des pilotes.
 * On en tire une archive pgscore, écrite ensuite comme un import FSDB ; les points sont recalculés.
 *
 * Ce que la page ne donne pas : le type de goal (lu comme un cylindre) et le Leading Time Ratio
 * (celui de la formule).
 */

export const CIVLCOMPS_HOST = "civlcomps.org";
/** Largeur habituelle d'une ligne de goal, en mètres. */
export const GOAL_LINE_LENGTH = 200;
const USER_AGENT = "pgscore (import de compétition à la demande d'un organisateur)";

/** Téléchargement : adresse → octets. Remplaçable pour les tests. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
  if (!res.ok) throw new FormError(t("civlcomps.org a répondu {status} pour {url}.", { status: res.status, url }));
  return new Uint8Array(await res.arrayBuffer());
};

/** Adresse de la page de résultats d'un événement, à partir de n'importe quelle page de l'événement. */
export function civlResultsUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new FormError(t("Adresse civlcomps.org attendue, par exemple https://civlcomps.org/event/german-open-2026/results"));
  }
  const m = /^\/event\/([^/]+)/.exec(u.pathname);
  if (!/(^|\.)civlcomps\.org$/i.test(u.hostname) || !m || m[1] === "download-file")
    throw new FormError(t("Adresse civlcomps.org attendue, par exemple https://civlcomps.org/event/german-open-2026/results"));
  return `https://${CIVLCOMPS_HOST}/event/${m[1]}/results`;
}

// --- Lecture du HTML ----------------------------------------------------------------------------

export function htmlText(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1] ?? null;

interface HtmlTable {
  /** Texte qui précède le tableau (titre de section), en clair. */
  before: string;
  headers: string[];
  rows: string[][];
}

/** Tableaux de la page (FS les produit sans tableaux imbriqués), avec le titre qui les précède. */
export function htmlTables(html: string): HtmlTable[] {
  const out: HtmlTable[] = [];
  const re = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let last = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const before = htmlText(html.slice(Math.max(last, m.index - 600), m.index)).slice(-120);
    last = m.index + m[0].length;
    const body = m[1]!;
    const headers = [...body.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => htmlText(x[1]!));
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((r) => [...r[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => htmlText(x[1]!)))
      .filter((r) => r.length);
    out.push({ before, headers, rows });
  }
  return out;
}

// --- Page de l'événement -----------------------------------------------------------------------

export interface CivlTaskLink {
  date: string | null;
  label: string;
  type: "race" | "time-trial";
  igcUrl: string | null;
  /** Résultats de la manche (le premier est le classement général de la manche). */
  results: Array<{ label: string; url: string }>;
}

export interface CivlEvent {
  name: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  tasks: CivlTaskLink[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ymd = (y: string, mon: string, d: string) => {
  const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  return m < 0 ? null : `${y}-${String(m + 1).padStart(2, "0")}-${d.padStart(2, "0")}`;
};

/** « Sep 14 - Sep 20, 2026 » ou « Dec 28, 2025 - Jan 3, 2026 » → dates AAAA-MM-JJ. */
export function eventDates(s: string): { start: string | null; end: string | null } {
  const m = /([A-Za-z]{3})\w*\s+(\d{1,2})(?:,\s*(\d{4}))?\s*-\s*(?:([A-Za-z]{3})\w*\s+)?(\d{1,2}),\s*(\d{4})/.exec(s);
  if (!m) return { start: null, end: null };
  const [, m1, d1, y1, m2, d2, y2] = m;
  return { start: ymd(y1 ?? y2!, m1!, d1!), end: ymd(y2!, m2 ?? m1!, d2!) };
}

const abs = (href: string) => new URL(href.replace(/&amp;/g, "&"), `https://${CIVLCOMPS_HOST}/`).toString();

export function parseEventPage(html: string): CivlEvent {
  const name = htmlText(/<h1[^>]*class="[^"]*title-event[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "");
  const place = htmlText(/<span[^>]*class="[^"]*place-event[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? "");
  const dates = eventDates(htmlText(/<span[^>]*class="[^"]*date-event[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? ""));
  const list = /<table\b[^>]*class="[^"]*task-list[^"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1] ?? "";
  const tasks: CivlTaskLink[] = [];
  for (const row of list.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]!);
    if (cells.length < 2) continue;
    const info = cells[0]!;
    const head = htmlText(/<div[^>]*class="date-item"[^>]*>([\s\S]*?)<\/div>/i.exec(info)?.[1] ?? "");
    const kind = htmlText(/<div[^>]*class="task-item"[^>]*>([\s\S]*?)<\/div>/i.exec(info)?.[1] ?? "");
    const date = /(\d{4}-\d{2}-\d{2})/.exec(head)?.[1] ?? null;
    const igc = [...info.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].find((a) => /\bIGC\b/i.test(htmlText(a[2]!)));
    // La colonne « Task results » vient avant « Competition results ».
    const resCell = cells.find((c) => /Task results/i.test(htmlText(c))) ?? cells[1]!;
    const results = [...resCell.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
      .map((a) => ({ label: htmlText(a[2]!), url: attr(a[1]!, "href") }))
      .filter((a): a is { label: string; url: string } => !!a.url && /\/results\//.test(a.url))
      .map((a) => ({ label: a.label, url: abs(a.url) }));
    tasks.push({
      date,
      label: head.replace(date ?? "", "").trim() || t("Manche {n}", { n: tasks.length + 1 }),
      type: /elapsed/i.test(kind) ? "time-trial" : "race",
      igcUrl: igc ? abs(attr(igc[1]!, "href") ?? "") : null,
      results,
    });
  }
  return { name: name || t("Compétition civlcomps"), location: place || null, start_date: dates.start, end_date: dates.end, tasks };
}

// --- Page de résultats d'une manche ---------------------------------------------------------

export interface CivlPilotRow {
  key: string;
  name: string;
  gender: "F" | "M" | null;
  nation: string | null;
  glider: string;
  sponsor: string;
  /** Rang, ou ABS, DNF… */
  rank: string;
  /** Heure de départ (SS) du pilote, telle qu'affichée. */
  start: string | null;
  /** Distance publiée, en km (null si la colonne manque ou est vide). */
  distance: number | null;
  /** Somme des colonnes de points (distance, leading, temps…) et total publié, s'ils sont lisibles. */
  pointsSum: number | null;
  total: number | null;
  /** Points de temps publiés (avant réduction d'elevated goal, que FS applique seulement au total). */
  timePoints: number | null;
}

export interface CivlTaskPage {
  turnpoints: Array<{ label: string; name: string; radius: number; open: string | null; close: string | null; lat: number; lon: number; altitude: number }>;
  startTimes: string[];
  deadline: string | null;
  stop: { time: string; scoreBackMinutes: number } | null;
  /** Décalage horaire du site, en minutes, lu sur les heures complètes des statistiques. */
  utcOffset: number | null;
  stats: Record<string, string>;
  formula: Record<string, string>;
  penalties: Array<{ key: string; name: string; percent: number; points: number; reason: string }>;
  pilots: CivlPilotRow[];
}

const params = (tb: HtmlTable | undefined): Record<string, string> =>
  Object.fromEntries((tb?.rows ?? []).filter((r) => r.length >= 2 && r[0]).map((r) => [r[0]!, r[1]!]));

const hm = (s: string | undefined) => {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s ?? "");
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}` : null;
};

/** Heures de départ : « Start at 12:00. », éventuellement plusieurs portes. */
export function startTimes(info: string): string[] {
  const seg = /Start(?: gates?)? at (.*?)(?:Task deadline|$)/i.exec(info)?.[1] ?? "";
  const times = [...seg.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map((m) => hm(m[1])!);
  const every = /every\s+(\d+)\s*min/i.exec(seg);
  const count = /(\d+)\s*(?:start\s*)?gates/i.exec(seg);
  if (times.length === 1 && every && count) {
    const [h, m] = times[0]!.split(":").map(Number) as [number, number];
    return Array.from({ length: Number(count[1]) }, (_, i) => {
      const x = h * 60 + m + i * Number(every[1]);
      return `${String(Math.floor(x / 60) % 24).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}:00`;
    });
  }
  return times;
}

const num = (s: string | undefined) => {
  const n = Number(String(s ?? "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

/** Colonnes « … Points » et « Total » d'une ligne de résultats. */
function pointsOf(headers: string[], r: string[]): { pointsSum: number | null; total: number | null; timePoints: number | null } {
  const iTime = headers.findIndex((h) => /^Time Points$/i.test(h));
  const timePoints = iTime >= 0 && r[iTime] !== "" && Number.isFinite(Number(r[iTime])) ? Number(r[iTime]) : null;
  const cols = headers.map((h, i) => (/Points$/i.test(h) ? i : -1)).filter((i) => i >= 0);
  const iTotal = headers.indexOf("Total");
  const total = iTotal >= 0 && r[iTotal] !== "" ? Number(r[iTotal]) : NaN;
  if (!cols.length || !Number.isFinite(total)) return { pointsSum: null, total: null, timePoints };
  const sum = cols.reduce((acc, i) => acc + (Number(r[i]) || 0), 0);
  return { pointsSum: sum, total, timePoints };
}

export function parseTaskPage(html: string): CivlTaskPage {
  const tables = htmlTables(html);
  const find = (title: RegExp, header?: string) => tables.find((x) => title.test(x.before) && (!header || x.headers.includes(header)));
  const def = tables.find((x) => x.headers.includes("Coordinates") && x.headers.includes("Radius"));
  if (!def) throw new FormError(t("Page de résultats sans définition de manche."));
  const h = (name: string) => def.headers.indexOf(name);
  const turnpoints = def.rows.map((r) => {
    const coords = /Lat:\s*(-?[\d.]+),\s*Lon:\s*(-?[\d.]+)/i.exec(r[h("Coordinates")] ?? "");
    return {
      label: r[h("No")] ?? "",
      name: r[h("Id")] ?? "",
      radius: num(r[h("Radius")]),
      open: hm(r[h("Open")]),
      close: hm(r[h("Close")]),
      lat: Number(coords?.[1]),
      lon: Number(coords?.[2]),
      altitude: num(r[h("Altitude")]) || 0,
    };
  });
  const infoStart = html.search(/Task info/i);
  const info = infoStart < 0 ? "" : htmlText(html.slice(infoStart, html.indexOf("<table", infoStart)));
  const stopM = /Stopped at (\d{1,2}:\d{2})(?:.*?scored back by (\d+) ?min)?/i.exec(info);
  const stats = params(find(/Task statistics/i, "param"));
  const formula = params(find(/formula/i, "param"));
  // Heures complètes des statistiques (« 2026-06-16T12:00:00+02:00 ») : décalage du site.
  let utcOffset: number | null = null;
  for (const v of Object.values(stats)) {
    const m = /^\d{4}-\d{2}-\d{2}T[\d:]+([+-])(\d{2}):(\d{2})$/.exec(v);
    if (m && !v.startsWith("2000-")) {
      utcOffset = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
      break;
    }
  }
  const pen = find(/Penalties/i, "Penalty Reason");
  const penalties = (pen?.rows ?? []).map((r) => {
    const pct = r[2] ?? "";
    return {
      key: r[0] ?? "",
      name: r[1] ?? "",
      // « 84.0% » ; une ancienne écriture donne la fraction (0.84).
      percent: pct.includes("%") ? num(pct) : num(pct) * 100 || 0,
      points: num(r[3]) || 0,
      reason: r[4] ?? "",
    };
  });
  const res = tables.find((x) => x.headers.includes("Id") && x.headers.includes("Name") && x.headers.includes("Nat"));
  const pilots: CivlPilotRow[] = [];
  if (res) {
    const c = (n: string) => res.headers.indexOf(n);
    const iName = c("Name");
    // Colonne sans titre après le nom : le genre (M/F).
    const iGender = res.headers[iName + 1] === "" ? iName + 1 : -1;
    const iDist = res.headers.findIndex((h) => /^Distance\b/i.test(h));
    for (const r of res.rows) {
      const key = r[c("Id")] ?? "";
      if (!key || !r[iName]) continue;
      const g = iGender >= 0 ? (r[iGender] ?? "").toUpperCase() : "";
      pilots.push({
        key,
        name: r[iName]!,
        gender: g === "F" ? "F" : g === "M" ? "M" : null,
        nation: r[c("Nat")] || null,
        glider: c("Glider") >= 0 ? (r[c("Glider")] ?? "") : "",
        sponsor: c("Sponsor") >= 0 ? (r[c("Sponsor")] ?? "") : "",
        rank: r[0] ?? "",
        start: c("SS") >= 0 ? hm(r[c("SS")]) : null,
        distance: iDist >= 0 && r[iDist] !== "" && Number.isFinite(Number(r[iDist])) ? Number(r[iDist]) : null,
        ...pointsOf(res.headers, r),
      });
    }
  }
  return {
    turnpoints,
    startTimes: startTimes(info),
    deadline: hm(/deadline at (\d{1,2}:\d{2})/i.exec(info)?.[1]),
    stop: stopM ? { time: hm(stopM[1])!, scoreBackMinutes: stopM[2] ? Number(stopM[2]) : 5 } : null,
    utcOffset,
    stats,
    formula,
    penalties,
    pilots,
  };
}

// --- Conversion ---------------------------------------------------------------------------------

/** "HH:MM:SS" locale → UTC, avec le décalage du site en minutes. */
function toUtc(local: string, offset: number): string {
  const [h, m, s] = local.split(":").map(Number) as [number, number, number];
  const x = (((h * 60 + m - offset) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function zoneFromOffset(min: number | null): string | null {
  if (min === null) return null;
  if (min === 0) return "UTC";
  if (min % 60) return null;
  const h = min / 60;
  return `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`;
}

/** Fuseau IANA d'une position et son décalage (minutes) à midi UTC le jour donné. */
export function zoneAt(tp: { lat: number; lon: number } | undefined, date: string | null): { id: string; offset: number } | null {
  if (!tp || !Number.isFinite(tp.lat) || !Number.isFinite(tp.lon) || (tp.lat === 0 && tp.lon === 0)) return null;
  let id: string;
  try {
    id = tzLookup(tp.lat, tp.lon);
  } catch {
    return null;
  }
  const at = date ? Date.parse(`${date}T12:00:00Z`) : NaN;
  if (!Number.isFinite(at)) return null;
  return { id, offset: offsetMinutes(at, id) };
}

/** Manche du moteur à partir de la page FS. */
export function taskFromPage(p: CivlTaskPage, type: "race" | "time-trial", offset: number, n: number): StoredTask {
  const tps = p.turnpoints;
  if (tps.length < 2) throw new FormError(t("Manche {n} : au moins deux balises attendues.", { n }));
  let ss = tps.findIndex((x) => /SS/i.test(x.label.replace(/ES/i, "")));
  const es = tps.findIndex((x) => /ES/i.test(x.label.replace(/SS/i, "")));
  if (ss < 0) ss = Math.min(1, tps.length - 1);
  const last = tps.length - 1;
  const turnpoints: TaskTurnpoint[] = tps.map((x, i) => {
    // Le décollage peut avoir un rayon nul (FS, XCTrack) : c'est un point, pas une zone à valider.
    const takeoff = i === 0 && ss > 0;
    if (!Number.isFinite(x.lat) || !Number.isFinite(x.lon) || !(x.radius > 0 || (takeoff && x.radius === 0)))
      throw new FormError(t("Manche {n} : balise {tp} illisible.", { n, tp: x.name || String(i + 1) }));
    const role = i === last ? "goal" : i === ss ? "sss" : i === es ? "ess" : takeoff ? "takeoff" : "turnpoint";
    return { role, zone: { kind: "cylinder" as const, waypoint: { name: x.name || `TP${i + 1}`, lat: x.lat, lon: x.lon, altitude: x.altitude }, radius: x.radius } };
  });
  fitToStats(turnpoints, p.stats, ss);
  const starts = p.startTimes.length ? p.startTimes : tps[ss]?.open ? [tps[ss]!.open!] : [];
  const task: StoredTask = { type, turnpoints, startGates: starts.map((s) => toUtc(s, offset)) };
  if (ss > 0 && tps[0]!.open) task.takeoffOpen = toUtc(tps[0]!.open, offset);
  if (ss > 0 && tps[0]!.close) task.takeoffClose = toUtc(tps[0]!.close, offset);
  const deadline = p.deadline ?? tps[last]!.close;
  if (deadline) task.deadline = toUtc(deadline, offset);
  if (p.stop) {
    task.stopAnnouncement = toUtc(p.stop.time, offset);
    task.scoreBackTime = p.stop.scoreBackMinutes * 60;
    const gr = Number(p.formula.bonus_gr);
    if (p.formula.bonus_gr && Number.isFinite(gr) && gr >= 0) task.bonusGlideRatio = gr;
  }
  // FS GAP2025 : partie de vol manquante des pilotes posés comptée autrement, jusqu'au dernier posé
  // (US Open Chelan 2026).
  if (/^GAP2025$/i.test(p.formula.id ?? "")) {
    task.leadingFormula = "GAP2025";
    task.leadingEnd = "lastLanding";
  }
  const present = Number(p.stats.no_of_pilots_present);
  if (Number.isInteger(present) && present > 0) task.pilotsPresent = present;
  return task;
}

/**
 * La page ne dit pas toujours juste où est l'ESS (certaines marquent « ES » sur le goal) et ne donne pas
 * le type de goal. Les statistiques de FS donnent les distances calculées (task_distance,
 * launch_to_ess_distance) : on retient l'ESS et le type de goal qui les retrouvent.
 */
export function fitToStats(turnpoints: TaskTurnpoint[], stats: Record<string, string>, ss: number): void {
  const wantTask = Number(stats.task_distance) * 1000;
  const wantEss = Number(stats.launch_to_ess_distance) * 1000;
  if (!(wantTask > 0) || !(wantEss > 0)) return;
  const last = turnpoints.length - 1;
  const goal = turnpoints[last]!;
  const cyl = goal.zone;
  if (cyl.kind !== "cylinder") return;
  // FS donne la demi-longueur de la ligne dans le rayon.
  const line = { kind: "goal-line" as const, waypoint: cyl.waypoint, length: 2 * cyl.radius };
  const roles = turnpoints.map((x) => x.role);
  const tol = (d: number) => Math.max(50, d * 0.001);
  let best: { err: number; ess: number; zone: typeof cyl | typeof line } | null = null;
  // Un goal de plus de 200 m est presque toujours un cylindre : la ligne n'est envisagée qu'en dessous.
  for (const zone of cyl.radius > GOAL_LINE_LENGTH ? [cyl] : [cyl, line])
    for (let ess = ss + 1; ess <= last; ess++) {
      const trial = turnpoints.map((x, i) => ({
        role: i === last ? ("goal" as const) : i === ess ? ("ess" as const) : x.role === "ess" ? ("turnpoint" as const) : x.role,
        zone: i === last ? zone : x.zone,
      }));
      let d;
      try {
        d = taskDistances({ type: "race", turnpoints: trial, startGates: [] });
      } catch {
        continue;
      }
      const err = Math.abs(d.task - wantTask) / tol(wantTask) + Math.abs(d.launchToEss - wantEss) / tol(wantEss);
      // À égalité, on garde la lecture de la page (cylindre, ESS marqué).
      const pref = (zone === cyl ? 0 : 0.01) + (roles[ess] === "ess" || (ess === last && !roles.includes("ess")) ? 0 : 0.01);
      if (!best || err + pref < best.err) best = { err: err + pref, ess, zone };
    }
  if (!best || best.err > 2) return;
  turnpoints.forEach((x, i) => {
    if (i === last) x.zone = best.zone;
    else if (i === best.ess) x.role = "ess";
    else if (x.role === "ess") x.role = "turnpoint";
  });
}

export function settingsFromFormula(f: Record<string, string>, offset: number | null, zone?: string): CompetitionSettings {
  const pwc = /^PWC/i.test(f.id ?? "");
  const n = (k: string, fallback: number) => (f[k] !== undefined && f[k] !== "" && Number.isFinite(Number(f[k])) ? Number(f[k]) : fallback);
  return {
    ...DEFAULT_SETTINGS,
    nominalDistance: n("nom_dist", DEFAULT_SETTINGS.nominalDistance / 1000) * 1000,
    minimumDistance: n("min_dist", DEFAULT_SETTINGS.minimumDistance / 1000) * 1000,
    nominalTime: Math.round(n("nom_time", DEFAULT_SETTINGS.nominalTime / 3600) * 3600),
    ftvFactor: n("ftv_factor", 0),
    gapProfile: pwc ? "PWCA" : "S7F2026",
    airspacePenaltyRule: pwc ? "pwca-soft" : "s7a",
    timeZone: zone ?? zoneFromOffset(offset) ?? DEFAULT_SETTINGS.timeZone,
  };
}

const norm = (s: string) =>
  decodeFsName(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

/**
 * Pilote d'une trace d'après le nom du fichier : « 7_Boris_Kosog.igc » (numéro devant), « LiveTrack
 * Adrien Raisson..20260616-082855.60845.60.igc » (FS : CIVL ID puis numéro à la fin), sinon le nom.
 */
export function pilotForTrack(path: string, pilots: Map<string, string>): string | null {
  const file = path.split(/[\\/]/).pop() ?? path;
  const stem = file.replace(/\.igc$/i, "");
  const front = /^(\d+)[_\s.-]/.exec(stem)?.[1];
  if (front && pilots.has(front)) return front;
  const words = (s: string) => norm(s).split(" ").filter(Boolean);
  // Nom écrit en clair dans un fichier LiveTrack (« LiveTrack Prénom Nom.<id>… » ou « LiveTrack Prénom Nom..<date>… »).
  const live = /^LiveTrack\s+/i.test(stem) ? words(stem.replace(/^LiveTrack\s+/i, "").replace(/\..*$/, "")) : [];
  const back = /\.(\d+)$/.exec(stem)?.[1];
  // Le numéro de la fin est celui du pilote, sauf si le nom du fichier en désigne un autre : le ZIP de civlcomps
  // garde les traqueurs de pilotes absents des résultats (Siatista 2024, manche 1 : « LiveTrack Andrea
  // Carloni….4.igc » alors que le 4 est Kotsiras Ilias).
  if (back && pilots.has(back) && (!live.length || words(pilots.get(back)!).some((w) => live.includes(w)))) return back;
  const name = (live.length ? live : words(stem.replace(/\.\..*$/, ""))).sort().join(" ");
  if (name)
    for (const [key, n] of pilots) {
      if (words(n).sort().join(" ") === name) return key;
    }
  return null;
}

export interface CivlImportProgress {
  (message: string): void;
}

/**
 * Lit un événement civlcomps.org et le décrit comme une archive pgscore, prête pour writeArchive.
 * Avec `store`, chaque trace est rangée dès qu'elle est décompressée.
 */
/**
 * Élévation d'un elevated goal (13.1) qui explique le mieux les écarts publiés : pour chaque pilote au goal,
 * la réduction de ses points de temps doit égaler l'écart entre la somme de ses points et son total.
 * Renvoie undefined si aucune élévation n'explique mieux les écarts qu'un goal ordinaire.
 */
export function fitElevatedGoal(task: StoredTask, goalAltitudes: Map<string, number>, timePoints: Map<string, number>, gaps: Map<string, number>): number | undefined {
  const goalAlt = task.turnpoints.at(-1)!.zone.waypoint.altitude ?? 0;
  const misses = (elevation: number) => {
    let n = 0;
    for (const [k, alt] of goalAltitudes) {
      const tp = timePoints.get(k) ?? 0;
      const reduction = Math.round(tp * (1 - goalAltitudeFactor(alt, goalAlt, elevation)) * 10) / 10;
      if (Math.abs(reduction - (gaps.get(k) ?? 0)) > 0.15) n++;
    }
    return n;
  };
  let best = { elevation: 0, misses: misses(0) };
  // Valeurs rondes d'abord : à égalité, 300 m l'emporte sur 290 m.
  const candidates = [100, 50, 10].flatMap((step) => Array.from({ length: 1000 / step }, (_, i) => (i + 1) * step));
  for (const e of new Set(candidates)) {
    const m = misses(e);
    if (m < best.misses) best = { elevation: e, misses: m };
  }
  return best.elevation || undefined;
}

export async function civlToArchive(
  url: string,
  fetcher: Fetcher = httpFetcher,
  store?: TrackStore,
  progress: CivlImportProgress = () => {},
): Promise<{ a: CompetitionArchive; files: Record<string, ArchiveFile>; warnings: string[] }> {
  const resultsUrl = civlResultsUrl(url);
  const dec = new TextDecoder();
  const event = parseEventPage(dec.decode(await fetcher(resultsUrl)));
  if (!event.tasks.length) throw new FormError(t("Aucune manche publiée sur {url}.", { url: resultsUrl }));
  const warnings: string[] = [];
  const pilots = new Map<string, PilotFields>();
  const files: Record<string, ArchiveFile> = {};
  const tasks: ArchiveTask[] = [];
  let settings: CompetitionSettings | null = null;
  let unmatched = 0;

  for (const [i, link] of event.tasks.entries()) {
    const n = i + 1;
    const overall = link.results[0];
    if (!overall) {
      warnings.push(t("{task} : pas de résultats publiés, manche ignorée.", { task: link.label }));
      continue;
    }
    progress(t("{task} : lecture de la manche", { task: link.label }));
    const page = parseTaskPage(dec.decode(await fetcher(overall.url)));
    // Les statistiques vides (FS ancien, manche sans pilote) ne donnent pas le décalage : on le déduit
    // de la position du décollage, au jour de la manche.
    const zone = page.utcOffset === null ? zoneAt(page.turnpoints[0], link.date) : null;
    const offset = page.utcOffset ?? zone?.offset ?? 0;
    if (zone) warnings.push(t("{task} : fuseau horaire absent de la page, déduit du décollage : {zone}.", { task: link.label, zone: zone.id }));
    else if (page.utcOffset === null) warnings.push(t("{task} : fuseau horaire introuvable, heures lues en UTC.", { task: link.label }));
    settings ??= settingsFromFormula(page.formula, page.utcOffset ?? zone?.offset ?? null, zone?.id);
    // civlcomps annonce parfois « Elapsed time » pour une course : si tous les pilotes partent à la même
    // heure, c'est une course à une porte.
    let type = link.type;
    const starts = new Set(page.pilots.map((r) => r.start).filter(Boolean));
    if (type === "time-trial" && starts.size === 1 && page.pilots.filter((r) => r.start).length > 1) {
      type = "race";
      warnings.push(t("{task} : annoncée en temps écoulé, mais tous les pilotes partent à {time} : lue comme une course.", { task: link.label, time: [...starts][0]! }));
    }
    const task = taskFromPage(page, type, offset, n);

    const names = new Map<string, string>();
    for (const r of page.pilots) {
      names.set(r.key, r.name);
      if (pilots.has(r.key)) continue;
      const [gliderText, harnessText] = r.glider.split(/\s+[|/]\s+/);
      const glider = splitBrand(gliderText ?? "");
      const harness = splitBrand(harnessText ?? "");
      try {
        pilots.set(
          r.key,
          cleanPilot({
            pilot_key: r.key,
            name: r.name,
            gender: r.gender,
            nation: r.nation,
            glider_brand: glider.brand,
            glider_model: glider.model,
            harness_brand: harness.brand,
            harness_model: harness.model,
            sponsor: r.sponsor,
          }),
        );
      } catch (e) {
        warnings.push(t("{task} : pilote {key} ignoré ({error}).", { task: link.label, key: r.key, error: (e as Error).message }));
      }
    }

    const decisions: ArchiveTask["decisions"] = [];
    for (const p of page.penalties) {
      const key = p.key || [...names].find(([, nm]) => nm === p.name)?.[0];
      if (!key) continue;
      const reason = p.reason || t("Pénalité reprise de civlcomps.org");
      const base = { pilot_key: key, pilot_name: names.get(key) ?? p.name, reason, created_at: Date.now() };
      if (p.percent) decisions.push({ ...base, kind: "penalty-percent", value: Math.round(p.percent * 100) / 100 });
      if (p.points > 0) decisions.push({ ...base, kind: "penalty", value: p.points });
      if (p.points < 0) decisions.push({ ...base, kind: "bonus", value: -p.points });
    }

    // Écart entre la somme des points et le total publié, une fois les pénalités listées déduites : elevated goal
    // (FS publie les points de temps sans la réduction, 13.1) ou pénalités que FS n'a pas listées.
    const unexplained = new Map<string, number>();
    for (const r of page.pilots) {
      if (r.pointsSum === null || r.total === null || r.total <= 0) continue;
      let expected = r.pointsSum;
      for (const d of decisions.filter((x) => x.pilot_key === r.key)) {
        if (d.kind === "penalty-percent") expected -= (r.pointsSum * (d.value ?? 0)) / 100;
        if (d.kind === "penalty") expected -= d.value ?? 0;
        if (d.kind === "bonus") expected += d.value ?? 0;
      }
      unexplained.set(r.key, Math.round((Math.max(0, expected) - r.total) * 10) / 10);
    }
    const timePoints = new Map(page.pilots.filter((r) => r.timePoints).map((r) => [r.key, r.timePoints!]));
    const fitGoal = [...unexplained].some(([k, v]) => v >= 0.2 && timePoints.has(k));
    const goalAltitudes = new Map<string, number>();

    // Absents et non partis, comme les a notés l'organisateur (leur trace éventuelle ne compte pas).
    for (const r of page.pilots) {
      const kind = /^ABS$/i.test(r.rank) ? "abs" : /^DNF$/i.test(r.rank) ? "dnf" : null;
      if (kind) decisions.push({ pilot_key: r.key, pilot_name: r.name, kind, value: null, reason: t("Repris de civlcomps.org ({status})", { status: r.rank.toUpperCase() }), created_at: Date.now() });
    }

    const tracks: ArchiveTask["tracks"] = [];
    if (link.igcUrl) {
      progress(t("{task} : téléchargement des traces", { task: link.label }));
      const zip = await fetcher(link.igcUrl);
      // ZIP lu fichier par fichier : une seule trace décompressée à la fois.
      let reader: ZipReader;
      try {
        reader = ZipReader.open(zip);
      } catch (e) {
        throw new FormError(t("{task} : ZIP des traces illisible ({error}).", { task: link.label, error: (e as Error).message }));
      }
      const listing = reader.names().filter((name) => /\.igc$/i.test(name) && !name.startsWith("__MACOSX/"));
      for (const path of listing) {
        const key = pilotForTrack(path, names);
        if (!key) {
          unmatched++;
          continue;
        }
        let data: Uint8Array;
        try {
          data = reader.file(path);
        } catch (e) {
          throw new FormError(t("{task} : ZIP des traces illisible ({error}).", { task: link.label, error: (e as Error).message }));
        }
        const sha256 = store ? store.put(data) : createHash("sha256").update(data).digest("hex");
        const file = `tracks/m${n}/${sha256}.igc`;
        if (files[file]) continue;
        files[file] = store ? { stored: sha256, size: data.length } : data;
        const filename = decodeFsName(path.split(/[\\/]/).pop() ?? path);
        tracks.push({ pilot_key: key, pilot_name: names.get(key) ?? null, filename, sha256, size: data.length, uploaded_at: Date.now(), note: null, file });
        if (fitGoal && timePoints.has(key)) {
          try {
            const c = controlFlight(task, parseIgc(dec.decode(data)).fixes);
            if (c.madeGoal && c.goalAltitude !== null) goalAltitudes.set(key, c.goalAltitude);
          } catch {
            // Trace illisible : elle sera signalée au calcul.
          }
        }
      }
    } else warnings.push(t("{task} : pas de traces publiées.", { task: link.label }));

    // Elevated goal : FS ne publie pas l'élévation, on la retrouve par les altitudes de passage du goal.
    const factors = new Map<string, number>();
    if (goalAltitudes.size) {
      const elevation = fitElevatedGoal(task, goalAltitudes, timePoints, unexplained);
      if (elevation) {
        task.elevatedGoal = elevation;
        const goalAlt = task.turnpoints.at(-1)!.zone.waypoint.altitude ?? 0;
        for (const [k, alt] of goalAltitudes) factors.set(k, goalAltitudeFactor(alt, goalAlt, elevation));
        warnings.push(t("{task} : elevated goal de {m} m retrouvé d'après les points publiés.", { task: link.label, m: elevation }));
      }
    }
    // Ce qui reste : pénalités appliquées par FS sans être listées (petites pénalités d'espace aérien…).
    for (const r of page.pilots) {
      const gap = unexplained.get(r.key);
      if (gap === undefined) continue;
      const reduction = Math.round((timePoints.get(r.key) ?? 0) * (1 - (factors.get(r.key) ?? 1)) * 10) / 10;
      const missing = Math.round((gap - reduction) * 10) / 10;
      if (missing >= 0.2)
        decisions.push({ pilot_key: r.key, pilot_name: r.name, kind: "penalty", value: missing, reason: t("Pénalité appliquée par FS, non détaillée sur civlcomps.org"), created_at: Date.now() });
    }

    tasks.push({
      number: n,
      date: link.date,
      official: true,
      source: "civlcomps",
      source_text: overall.url,
      task,
      scoring_changed_at: null,
      decisions,
      tracks,
      result: null,
    });
  }
  if (unmatched) warnings.push(t("{n} traces du ZIP sans pilote reconnu n'ont pas été reprises.", { n: unmatched }));
  return {
    a: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exported_at: new Date().toISOString(),
      competition: {
        name: event.name,
        location: event.location,
        start_date: event.start_date,
        end_date: event.end_date,
        settings: settings ?? DEFAULT_SETTINGS,
        airspace: null,
      },
      pilots: [...pilots.values()],
      // Classement féminin, comme à la création d'une compétition, s'il y a des pilotes femmes.
      rankings: [...pilots.values()].some((p) => p.gender === "F")
        ? [{ name: "Féminin", rule: { conditions: [{ field: "gender", op: "in", value: "F" }] }, overrides: [] }]
        : [],
      tasks,
    },
    files,
    warnings,
  };
}
