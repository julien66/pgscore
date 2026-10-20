import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { BONUS_GLIDE_RATIO, type PilotResult, type TaskScoring, type TaskTurnpoint } from "@pgscore/engine";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, competitionArchive, type ArchiveTask, type CompetitionArchive } from "./archive.js";
import type { CompetitionRow, Db } from "./db.js";
import { t } from "./i18n.js";
import { fsdbCustom, fsdbPilot, type PilotFields } from "./pilots.js";
import type { RankingRule, RuleCondition } from "./rankings.js";
import { DEFAULT_SETTINGS, FormError, type CompetitionSettings, type StoredTask } from "./settings.js";
import { competitionStandings } from "./standings.js";
import { offsetMinutes } from "./time.js";
import type { TrackStore } from "./track-store.js";
import { cdata, child, children, el, parseXml, type XmlEl } from "./xml.js";

/**
 * Échange avec FS, le logiciel de la CIVL, par son fichier .fsdb (XML, version 3.5).
 *
 * Import : compétition, formule (distances et temps nominaux, FTV, profil GAP/PWC), pilotes, catégories
 * (classements extraits), manches (balises, portes, fenêtres, arrêt), pénalités saisies (FsResultPenalty)
 * et, si le .fsdb est envoyé dans un ZIP avec ses dossiers de traces (tracks\T01…), les traces IGC.
 * Les résultats calculés par FS ne sont pas repris : on relance le calcul dans pgscore.
 *
 * Export : la même chose dans l'autre sens, plus les résultats de pgscore (FsFlightData, FsResult,
 * FsTaskResults et FsCompetitionResults) pour que le fichier se lise comme un fichier FS calculé.
 */

// --- Heures ---------------------------------------------------------------------------------

/** "2026-08-15T13:30:00+02:00" → instant (ms UTC). */
function isoMs(s: string | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
const utcHms = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const localDate = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

/** Instant → "AAAA-MM-JJTHH:MM:SS+HH:MM" dans le fuseau donné, comme FS. */
export function fsTime(ms: number | null | undefined, timeZone: string): string {
  if (ms === null || ms === undefined) return "";
  const off = offsetMinutes(ms, timeZone);
  const local = new Date(ms + off * 60_000).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
/** "HH:MM:SS" UTC d'une manche datée → instant. */
const taskMs = (date: string | null, hms: string | undefined) => {
  if (!hms) return null;
  const [h, m, s] = hms.split(":").map(Number);
  return Date.parse(`${date ?? "2026-01-01"}T00:00:00Z`) + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
};
const hhmmss = (sec: number | null | undefined) => {
  if (sec === null || sec === undefined) return "00:00:00";
  const s = Math.round(sec);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** utc_offset de FS (heures) → fuseau IANA à décalage fixe. */
function zoneFromOffset(off: string | undefined, warnings: string[]): string {
  const h = Number(off);
  if (!Number.isFinite(h) || off === undefined || off === "") return DEFAULT_SETTINGS.timeZone;
  if (h === 0) return "UTC";
  if (Number.isInteger(h) && Math.abs(h) <= 14) return `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`;
  warnings.push(t("Décalage horaire {h} h non pris en charge : fuseau à régler dans les réglages.", { h: off }));
  return DEFAULT_SETTINGS.timeZone;
}

// --- Import ---------------------------------------------------------------------------------

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
};

function settingsFromFormula(f: XmlEl | undefined, comp: XmlEl, warnings: string[]): CompetitionSettings {
  const a = f?.attrs ?? {};
  const pwc = /^PWC/i.test(a.id ?? "");
  return {
    ...DEFAULT_SETTINGS,
    nominalDistance: num(a.nom_dist, DEFAULT_SETTINGS.nominalDistance / 1000) * 1000,
    minimumDistance: num(a.min_dist, DEFAULT_SETTINGS.minimumDistance / 1000) * 1000,
    nominalTime: Math.round(num(a.nom_time, DEFAULT_SETTINGS.nominalTime / 3600) * 3600),
    ftvFactor: num(a.ftv_factor ?? comp.attrs.ftv_factor, 0),
    gapProfile: pwc ? "PWCA" : "S7F2026",
    airspacePenaltyRule: pwc ? "pwca-soft" : "s7a",
    timeZone: zoneFromOffset(comp.attrs.utc_offset, warnings),
  };
}

/** Manche FS → manche du moteur. FsTurnpoint dans l'ordre ; ss et es sont des rangs (à partir de 1). */
function taskFromFs(def: XmlEl, state: XmlEl | undefined, formulaEl: XmlEl | undefined, warnings: string[], n: number): { task: StoredTask; date: string | null } {
  const tps = children(def, "FsTurnpoint");
  if (tps.length < 2) throw new FormError(t("Manche {n} du FSDB : au moins deux balises attendues.", { n }));
  const ss = num(def.attrs.ss, 1) - 1;
  const es = num(def.attrs.es, tps.length) - 1;
  const last = tps.length - 1;
  const turnpoints: TaskTurnpoint[] = tps.map((tp, i) => {
    const role = i === last ? "goal" : i === ss ? "sss" : i === es ? "ess" : i === 0 && ss > 0 ? "takeoff" : "turnpoint";
    const waypoint = { name: tp.attrs.id ?? `TP${i + 1}`, lat: num(tp.attrs.lat, NaN), lon: num(tp.attrs.lon, NaN), altitude: num(tp.attrs.altitude, 0) };
    if (!Number.isFinite(waypoint.lat) || !Number.isFinite(waypoint.lon)) throw new FormError(t("Manche {n} du FSDB : balise {tp} sans position.", { n, tp: waypoint.name }));
    const radius = num(tp.attrs.radius, 400);
    return role === "goal" && /LINE/i.test(def.attrs.goal ?? "")
      ? { role, zone: { kind: "goal-line" as const, waypoint, length: 2 * radius } }
      : { role, zone: { kind: "cylinder" as const, waypoint, radius } };
  });
  const gates = children(def, "FsStartGate")
    .map((g) => isoMs(g.attrs.open))
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const date = localDate(children(def, "FsStartGate")[0]?.attrs.open ?? tps[ss]?.attrs.open ?? tps[0]!.attrs.open);
  const task: StoredTask = { type: gates.length ? "race" : "time-trial", turnpoints, startGates: gates.map(utcHms) };
  if (!gates.length) warnings.push(t("Manche {n} : aucune porte de départ dans le FSDB, lue comme un time trial.", { n }));
  const open0 = isoMs(tps[0]!.attrs.open);
  const close0 = isoMs(tps[0]!.attrs.close);
  if (ss > 0 && open0 !== null) task.takeoffOpen = utcHms(open0);
  if (ss > 0 && close0 !== null) task.takeoffClose = utcHms(close0);
  const deadline = isoMs(tps[last]!.attrs.close);
  if (deadline !== null) task.deadline = utcHms(deadline);
  if (state?.attrs.task_state === "STOPPED") {
    const stop = isoMs(state.attrs.stop_time);
    if (stop !== null) task.stopAnnouncement = utcHms(stop);
    task.scoreBackTime = num(state.attrs.score_back_time, 5) * 60;
    const gr = Number(formulaEl?.attrs.bonus_gr);
    if (formulaEl?.attrs.bonus_gr && Number.isFinite(gr) && gr >= 0) task.bonusGlideRatio = gr;
  }
  const ltr = Number(def.attrs.leading_time_ratio);
  if (def.attrs.leading_time_ratio && Number.isFinite(ltr)) task.leadingTimeRatio = ltr;
  return { task, date };
}

/** Catégorie FS → règle de classement, ou membres calculés quand un critère n'a pas d'équivalent. */
function rankingFromCategory(cat: XmlEl, participants: XmlEl[], warnings: string[]): CompetitionArchive["rankings"][number] | null {
  const name = cat.attrs.name ?? "";
  const sels = children(child(cat, "FsCompCategorySelectors"), "FsCompCategorySelector").map((s) => s.attrs);
  if (!name || !sels.length) return null;
  const conds: RuleCondition[] = [];
  let exact = true;
  for (const s of sels) {
    const cmp = (s.comparator ?? "").toLowerCase();
    if (s.attributeName === "female" && cmp === "equals") conds.push({ field: "gender", op: "in", value: s.requiredValue === "1" ? "F" : "M" });
    else if (s.attributeName === "nat_code_3166_a3" && cmp === "equals") conds.push({ field: "nation", op: "in", value: (s.requiredValue ?? "").toUpperCase() });
    else exact = false;
  }
  if (exact) return { name, rule: { conditions: conds }, overrides: [] };
  // Critère sans équivalent (attribut personnalisé « ca:… ») : on évalue la catégorie sur les inscriptions
  // et on garde ses membres comme ajouts à la main.
  const value = (p: XmlEl, attr: string) => (attr.startsWith("ca:") ? (fsdbCustom(p)[normKey(attr.slice(3))] ?? "") : (p.attrs[attr] ?? ""));
  const ok = (p: XmlEl) =>
    sels.every((s) => {
      const v = value(p, s.attributeName ?? "").toLowerCase();
      const want = (s.requiredValue ?? "").toLowerCase();
      const cmp = (s.comparator ?? "").toLowerCase().replace(/[\s_]/g, "");
      if (cmp === "equals") return v === want;
      if (cmp === "contains") return v.includes(want);
      if (cmp === "notequals") return v !== want;
      if (cmp === "notcontains") return !v.includes(want);
      if (cmp === "startswith") return v.startsWith(want);
      warnings.push(t("Catégorie « {name} » : critère « {cmp} » inconnu, ignoré.", { name, cmp: s.comparator ?? "" }));
      return true;
    });
  const members = participants.filter(ok).map((p) => p.attrs.id ?? "").filter(Boolean);
  warnings.push(t("Catégorie « {name} » : critère sans équivalent dans pgscore, ses {n} pilotes sont ajoutés à la main au classement.", { name, n: members.length }));
  return { name, rule: { conditions: [] } as RankingRule, overrides: members.map((pilot_key) => ({ pilot_key, included: true })) };
}
const normKey = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Nom de fichier sans dossier, en minuscules, pour retrouver une trace dans le ZIP. */
// Certains outils de ZIP écrivent les lettres accentuées « #U00e9 » : on les redécode, et on compare en NFC.
const base = (p: string) =>
  p
    .split(/[\\/]/)
    .pop()!
    .replace(/#U([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .normalize("NFC")
    .toLowerCase();

/** Le fichier envoyé est-il du FSDB (XML seul, ou ZIP avec un .fsdb et pas d'archive pgscore) ? */
export function looksLikeFsdb(bytes: Uint8Array): boolean {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let names: string[] = [];
    try {
      names = Object.keys(unzipSync(bytes, { filter: (f) => /\.fsdb$/i.test(f.name) || f.name === "competition.json" }));
    } catch {
      return false;
    }
    return names.some((n) => /\.fsdb$/i.test(n)) && !names.includes("competition.json");
  }
  return /^\s*(<\?xml|<Fs[\s>])/.test(strFromU8(bytes.subarray(0, 200)).replace(/^﻿/, ""));
}

/**
 * Lit un .fsdb (ou un ZIP qui le contient avec les dossiers de traces) et le décrit comme une archive
 * pgscore, prête à être écrite par writeArchive.
 */
export function fsdbToArchive(bytes: Uint8Array): { a: CompetitionArchive; files: Record<string, Uint8Array>; warnings: string[] } {
  let text: string;
  let zipFiles: Record<string, Uint8Array> = {};
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    try {
      zipFiles = unzipSync(bytes, { filter: (f) => !f.name.startsWith("__MACOSX/") });
    } catch (e) {
      throw new FormError(t("Archive illisible : {error}", { error: (e as Error).message }));
    }
    const fsdb = Object.keys(zipFiles).filter((k) => /\.fsdb$/i.test(k));
    if (fsdb.length !== 1) throw new FormError(t("Le ZIP doit contenir un seul fichier .fsdb (trouvés : {n}).", { n: fsdb.length }));
    text = strFromU8(zipFiles[fsdb[0]!]!);
  } else text = strFromU8(bytes);
  let doc: XmlEl;
  try {
    doc = parseXml(text);
  } catch (e) {
    throw new FormError(t("FSDB illisible : {error}", { error: (e as Error).message }));
  }
  const comp = child(child(doc, "Fs"), "FsCompetition");
  if (!comp) throw new FormError(t("FSDB illisible : élément <FsCompetition> absent."));
  const warnings: string[] = [];
  const participants = children(child(comp, "FsParticipants"), "FsParticipant");
  const pilots: PilotFields[] = participants.map((p, n) => {
    try {
      return fsdbPilot(p);
    } catch (e) {
      throw new FormError(t("Pilote n° {n} du FSDB : {error}", { n: n + 1, error: (e as Error).message }));
    }
  });
  const names = new Map(pilots.map((p) => [p.pilot_key, p.name]));
  // Traces du ZIP par nom de fichier (FS les range dans tracks\T01, tracks\T02…).
  const igcByName = new Map<string, string[]>();
  for (const k of Object.keys(zipFiles)) if (/\.igc$/i.test(k)) igcByName.set(base(k), [...(igcByName.get(base(k)) ?? []), k]);
  const files: Record<string, Uint8Array> = {};
  let missing = 0;

  const fsTasks = children(child(comp, "FsTasks"), "FsTask");
  const used = new Set<number>();
  const tasks: ArchiveTask[] = fsTasks.map((ft, i) => {
    let n = Number(ft.attrs.id);
    if (!Number.isInteger(n) || n < 1 || used.has(n)) n = i + 1;
    used.add(n);
    const def = child(ft, "FsTaskDefinition");
    if (!def) throw new FormError(t("Manche {n} du FSDB : définition absente.", { n }));
    const state = child(ft, "FsTaskState");
    const { task, date } = taskFromFs(def, state, [child(ft, "FsScoreFormula"), child(comp, "FsScoreFormula")].find((f) => f?.attrs.bonus_gr), warnings, n);
    const folder = base(ft.attrs.tracklog_folder ?? "");
    const decisions: ArchiveTask["decisions"] = [];
    const tracks: ArchiveTask["tracks"] = [];
    for (const p of children(child(ft, "FsParticipants"), "FsParticipant")) {
      const key = p.attrs.id ?? "";
      if (!key) continue;
      for (const pen of children(p, "FsResultPenalty")) {
        const reason = (pen.attrs.penalty_reason ?? "").trim() || t("Pénalité reprise de FS");
        const frac = num(pen.attrs.penalty, 0);
        const pts = num(pen.attrs.penalty_points, 0);
        if (frac) decisions.push({ pilot_key: key, pilot_name: names.get(key) ?? null, kind: "penalty-percent", value: Math.round(frac * 10000) / 100, reason, created_at: Date.now() });
        if (pts > 0) decisions.push({ pilot_key: key, pilot_name: names.get(key) ?? null, kind: "penalty", value: pts, reason, created_at: Date.now() });
        if (pts < 0) decisions.push({ pilot_key: key, pilot_name: names.get(key) ?? null, kind: "bonus", value: -pts, reason, created_at: Date.now() });
      }
      const fname = child(p, "FsFlightData")?.attrs.tracklog_filename;
      if (!fname || !Object.keys(zipFiles).length) continue;
      const candidates = igcByName.get(base(fname)) ?? [];
      const path = candidates.find((c) => base(c.split(/[\\/]/).slice(-2, -1)[0] ?? "") === folder) ?? candidates[0];
      if (!path) {
        missing++;
        continue;
      }
      const data = zipFiles[path]!;
      const sha256 = createHash("sha256").update(data).digest("hex");
      const file = `tracks/m${n}/${sha256}.igc`;
      files[file] = data;
      tracks.push({ pilot_key: key, pilot_name: names.get(key) ?? null, filename: base(fname) === fname.toLowerCase() ? fname : fname.split(/[\\/]/).pop()!, sha256, size: data.length, uploaded_at: Date.now(), note: null, file });
    }
    // Pilotes présents au décollage : seule entrée de calcul reprise des résultats de FS.
    const sp = child(children(child(ft, "FsTaskResults"), "FsTaskResult")[0], "FsTaskScoreParams");
    const present = sp ? num(sp.attrs.no_of_pilots_present, 0) : 0;
    if (present > 0) task.pilotsPresent = present;
    return {
      number: n,
      date,
      official: state?.attrs.task_state !== "CANCELLED",
      source: "fsdb",
      source_text: "",
      task,
      scoring_changed_at: null,
      decisions,
      tracks,
      result: null,
    };
  });
  if (missing) warnings.push(t("{n} traces citées par le FSDB sont absentes du ZIP.", { n: missing }));
  if (!Object.keys(zipFiles).length && fsTasks.length)
    warnings.push(t("FSDB seul : les traces ne sont pas dedans. Envoyez un ZIP avec le .fsdb et ses dossiers de traces pour les reprendre."));
  const rankings = children(child(comp, "FsCompCategories"), "FsCompCategory")
    .map((c) => rankingFromCategory(c, participants, warnings))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const notes = child(comp, "FsCompetitionNotes")?.text.trim();
  void notes;
  return {
    a: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exported_at: new Date().toISOString(),
      competition: {
        name: comp.attrs.name || t("Compétition FS"),
        location: comp.attrs.location || null,
        start_date: localDate(comp.attrs.from),
        end_date: localDate(comp.attrs.to),
        settings: settingsFromFormula(child(comp, "FsScoreFormula"), comp, warnings),
        airspace: null,
      },
      pilots,
      rankings,
      tasks,
    },
    files,
    warnings,
  };
}

// --- Export ---------------------------------------------------------------------------------

const r1 = (v: number | null | undefined) => (v === null || v === undefined ? 0 : Math.round(v * 10) / 10);
const km3 = (m: number | null | undefined) => ((m ?? 0) / 1000).toFixed(3);

function formula(s: CompetitionSettings, task?: StoredTask): string {
  return el("FsScoreFormula", {
    id: s.gapProfile === "PWCA" ? "PWC2026" : "GAP2026",
    is_pg_comp: 1,
    ftv_factor: s.ftvFactor,
    min_dist: s.minimumDistance / 1000,
    nom_dist: s.nominalDistance / 1000,
    nom_time: Math.round((s.nominalTime / 3600) * 1000) / 1000,
    nom_launch: 0.96,
    nom_goal: 0.3,
    day_quality_override: 0,
    bonus_gr: task?.bonusGlideRatio ?? BONUS_GLIDE_RATIO,
    use_distance_points: 1,
    use_time_points: 1,
    use_leading_points: 1,
    use_arrival_position_points: 0,
    use_arrival_time_points: 0,
    use_departure_points: 0,
    use_leading_time_ratio: 1,
    score_back_time: 5,
    scoring_altitude: "GPS",
    number_of_decimals_task_results: 1,
    number_of_decimals_competition_results: 1,
  });
}

/** Catégorie FS d'un classement dont la règle s'exprime en critères FS (genre, nation unique). */
function category(name: string, rule: RankingRule): string | null {
  const sels: string[] = [];
  for (const c of rule.conditions) {
    const vals = c.value.split(",").map((v) => v.trim()).filter(Boolean);
    if (c.field === "gender" && c.op === "in" && vals.length === 1) sels.push(el("FsCompCategorySelector", { attributeName: "female", comparator: "equals", requiredValue: vals[0] === "F" ? 1 : 0 }));
    else if (c.field === "nation" && c.op === "in" && vals.length === 1) sels.push(el("FsCompCategorySelector", { attributeName: "nat_code_3166_a3", comparator: "equals", requiredValue: vals[0]!.toUpperCase() }));
    else return null;
  }
  if (!sels.length) return null;
  return el("FsCompCategory", { name, use_filter: "True", filter_from: "Overall" }, [el("FsCompCategorySelectors", {}, sels)]);
}

/** Pénalités saisies d'un pilote → FsResultPenalty (fraction + points, comme FS). */
function penaltyEl(decs: ArchiveTask["decisions"]): string | null {
  const pct = decs.filter((d) => d.kind === "penalty-percent").reduce((a, d) => a + (d.value ?? 0), 0);
  const pts = decs.filter((d) => d.kind === "penalty").reduce((a, d) => a + (d.value ?? 0), 0) - decs.filter((d) => d.kind === "bonus").reduce((a, d) => a + (d.value ?? 0), 0);
  const reasons = decs.filter((d) => d.kind === "penalty" || d.kind === "penalty-percent" || d.kind === "bonus").map((d) => d.reason);
  if (!reasons.length) return null;
  return el("FsResultPenalty", { penalty: Math.round(pct * 1e6) / 1e8, penalty_points: r1(pts), penalty_reason: reasons.join(" ; ") });
}

function flightAndResult(p: PilotResult, rank: number, tz: string, speedSection: number): string[] {
  const absent = p.status === "ABS" || p.status === "DNF";
  if (absent) return [];
  const out: string[] = [];
  out.push(
    el("FsFlightData", {
      distance: km3(p.flownDistance),
      bonus_distance: km3(p.stop?.bonusDistance ?? p.flownDistance),
      started_ss: fsTime(p.startTime, tz),
      finished_ss: fsTime(p.essTime, tz),
      tracklog_filename: "",
      reachedGoal: p.status === "GOAL" ? 1 : 0,
      lc: p.leadingCoefficient ?? undefined,
    }),
  );
  const penalties = (p.decisions ?? []).filter((d) => d.kind === "penalty" || d.kind === "penalty-percent" || d.kind === "bonus");
  out.push(
    el("FsResult", {
      rank,
      points: r1(p.total),
      pointswithoutpenalty: r1(p.score),
      distance: km3(p.distance),
      real_distance: km3(p.flownDistance),
      ss_time: hhmmss(p.essTime ? p.speedSectionTime : null),
      ss_time_dec_hours: p.essTime && p.speedSectionTime ? Math.round((p.speedSectionTime / 3600) * 1e6) / 1e6 : 0,
      distance_points: r1(p.points?.distance),
      time_points: r1(p.points?.time),
      leading_points: r1(p.points?.leading),
      arrival_points: r1(p.points?.arrival),
      departure_points: 0,
      penalty: 0,
      penalty_points: r1(p.penaltyPoints),
      penalty_reason: penalties.map((d) => d.reason).join(" ; "),
      started_ss: fsTime(p.startTime, tz),
      lc: p.leadingCoefficient ?? undefined,
      speed: p.essTime && p.speedSectionTime ? Math.round((speedSection / p.speedSectionTime) * 3.6 * 100) / 100 : undefined,
    }),
  );
  return out;
}

/** Fichier .fsdb d'une compétition. `trackFolder` : dossiers de traces quand elles sont jointes (ZIP). */
export function competitionFsdb(db: Db, comp: CompetitionRow, opts: { withTracks?: boolean } = {}): string {
  const a = competitionArchive(db, comp);
  const s = a.competition.settings;
  const tz = s.timeZone;
  const startMs = Date.parse(`${a.competition.start_date ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const utcOffset = offsetMinutes(startMs, tz) / 60;
  const st = competitionStandings(db, comp);
  // Pilotes vus seulement dans les résultats (traces sans inscription) : FS attend tout le monde dans FsParticipants.
  const known = new Set(a.pilots.map((p) => p.pilot_key));
  const extra = new Map<string, string>();
  for (const tk of a.tasks)
    for (const pr of ((tk.result?.results as TaskScoring | undefined)?.pilots ?? [])) if (!known.has(pr.id) && !extra.has(pr.id)) extra.set(pr.id, pr.name ?? pr.id);
  const participants = [...a.pilots, ...[...extra].map(([pilot_key, name]) => ({ pilot_key, name }) as (typeof a.pilots)[number])].map((p) => {
    const custom: Array<[string, string | null]> = [
      ["Wing Manufacturer", p.glider_brand],
      ["Wing Model", p.glider_model],
      ["PG Certification", p.glider_class],
      ["Harness Manufacturer", p.harness_brand],
      ["Harness Model", p.harness_model],
      ["PTV max", p.weight_max == null ? null : String(p.weight_max)],
    ];
    const kids = custom.filter(([, v]) => v).map(([name, value]) => el("FsCustomAttribute", { name, value }));
    return el(
      "FsParticipant",
      {
        id: p.pilot_key,
        name: p.name,
        nat_code_3166_a3: p.nation ?? "",
        female: p.gender === "F" ? 1 : 0,
        glider: [p.glider_brand, p.glider_model].filter(Boolean).join(" "),
        sponsor: p.sponsor ?? "",
        CIVLID: p.civl_id ?? "",
      },
      kids.length ? [el("FsCustomAttributes", {}, kids)] : [],
    );
  });
  const tasks = a.tasks.map((tk) => {
    const task = tk.task;
    const tpIdx = (role: string) => task.turnpoints.findIndex((x) => x.role === role);
    const ss = tpIdx("sss") + 1;
    const essI = tpIdx("ess");
    const es = (essI >= 0 ? essI : task.turnpoints.length - 1) + 1;
    const last = task.turnpoints.length - 1;
    const open = (i: number) => {
      const tp = task.turnpoints[i]!;
      if (tp.role === "takeoff") return taskMs(tk.date, task.takeoffOpen);
      return taskMs(tk.date, i >= ss - 1 ? task.startGates[0] : task.takeoffOpen);
    };
    const close = (i: number) => (task.turnpoints[i]!.role === "takeoff" ? taskMs(tk.date, task.takeoffClose) : taskMs(tk.date, task.deadline));
    const goal = task.turnpoints[last]!.zone;
    const def = el(
      "FsTaskDefinition",
      { ss, es, goal: goal.kind === "goal-line" ? "LINE" : "CIRCLE", qnh_setting: "1013.25", leading_time_ratio: (task as StoredTask).leadingTimeRatio },
      [
        ...task.turnpoints.map((tp, i) =>
          el("FsTurnpoint", {
            id: tp.zone.waypoint.name,
            lat: tp.zone.waypoint.lat,
            lon: tp.zone.waypoint.lon,
            altitude: Math.round(tp.zone.waypoint.altitude ?? 0),
            radius: tp.zone.kind === "goal-line" ? tp.zone.length / 2 : tp.zone.radius,
            open: fsTime(open(i), tz),
            close: fsTime(close(i), tz),
          }),
        ),
        ...task.startGates.map((g) => el("FsStartGate", { open: fsTime(taskMs(tk.date, g), tz) })),
      ],
    );
    const stopped = Boolean(task.stopAnnouncement);
    const state = el("FsTaskState", {
      task_state: stopped ? "STOPPED" : "REGULAR",
      score_back_time: Math.round((task.scoreBackTime ?? 300) / 60),
      cancel_reason: "",
      stop_time: stopped ? fsTime(taskMs(tk.date, task.stopAnnouncement), tz) : undefined,
    });
    const r = tk.result?.results as TaskScoring | undefined;
    const files = new Map(tk.tracks.map((x) => [x.pilot_key, x.filename]));
    const folder = `T${String(tk.number).padStart(2, "0")}`;
    const ranked = r?.pilots ?? [];
    const results = new Map(ranked.map((p, i) => [p.id, { p, rank: i + 1 }]));
    const keys = new Set([...a.pilots.map((p) => p.pilot_key), ...ranked.map((p) => p.id)]);
    const decByPilot = new Map<string, ArchiveTask["decisions"]>();
    for (const d of tk.decisions ?? []) decByPilot.set(d.pilot_key, [...(decByPilot.get(d.pilot_key) ?? []), d]);
    const parts = [...keys].map((key) => {
      const x = results.get(key);
      let kids = x ? flightAndResult(x.p, x.rank, tz, r!.distances.speedSection) : [];
      // Trace envoyée mais manche pas encore calculée : FsFlightData réduit au nom du fichier.
      if (!kids.length && files.has(key)) kids = [el("FsFlightData", { tracklog_filename: "" })];
      if (opts.withTracks && files.get(key) && kids[0]) kids = [kids[0].replace('tracklog_filename=""', `tracklog_filename="${files.get(key)!.replace(/"/g, "&quot;")}"`), ...kids.slice(1)];
      const pen = penaltyEl(decByPilot.get(key) ?? []);
      if (pen) kids = kids.length ? [kids[0]!, pen, ...kids.slice(1)] : [pen];
      return el("FsParticipant", { id: key }, kids);
    });
    const taskResults = r
      ? [
          el("FsTaskResults", {}, [
            el("FsTaskResult", { id: "overall", title: "Overall", filter_from_category: "", version: 1 }, [
              el("FsTaskScoreParams", {
                task_distance: km3(r.distances.task),
                ss_distance: km3(r.distances.speedSection),
                no_of_pilots_present: r.gap.pilotsPresent,
                no_of_pilots_flying: r.gap.pilotsFlying,
                no_of_pilots_reaching_es: r.gap.pilotsEss,
                no_of_pilots_reaching_goal: r.gap.pilotsGoal,
                best_dist: km3(r.gap.bestDistance),
                best_time: r.gap.bestTime ? Math.round((r.gap.bestTime / 3600) * 1e6) / 1e6 : 0,
                goalratio: Math.round(r.gap.goalRatio * 1e4) / 1e4,
                launch_validity: r.gap.validity.launch,
                distance_validity: r.gap.validity.distance,
                time_validity: r.gap.validity.time,
                stop_validity: r.gap.validity.stopped ?? 1,
                day_quality: r.gap.validity.task,
                distance_weight: r.gap.weights.distance,
                time_weight: r.gap.weights.time,
                leading_weight: r.gap.weights.leading,
                arrival_weight: r.gap.weights.arrival,
                available_points_distance: r1(r.gap.available.distance),
                available_points_time: r1(r.gap.available.time),
                available_points_leading: r1(r.gap.available.leading),
                available_points_arrival: r1(r.gap.available.arrival),
                smallest_leading_coefficient: r.lcMin ?? undefined,
                counts_for_competition: tk.official ? "True" : "False",
              }),
              el(
                "FsTaskResultParticipants",
                {},
                ranked
                  .filter((p) => p.total !== null)
                  .map((p, i) =>
                    el("FsTaskParticipantResult", {
                      id: p.id,
                      rank: i + 1,
                      distance_points: r1(p.points?.distance),
                      time_points: r1(p.points?.time),
                      leading_points: r1(p.points?.leading),
                      arrival_points: r1(p.points?.arrival),
                      departure_points: 0,
                      points: r1(p.total),
                    }),
                  ),
              ),
            ]),
          ]),
        ]
      : [];
    return el("FsTask", { id: tk.number, name: `Task ${tk.number}`, tracklog_folder: `tracks\\${folder}` }, [formula(s, task), def, state, el("FsParticipants", {}, parts), ...taskResults]);
  });
  const ranking = st.ranking;
  const compResults = ranking.pilots.length
    ? [
        el("FsCompetitionResults", {}, [
          el(
            "FsCompetitionResult",
            { id: "overall", title: "Overall", top: "all", tasks: ranking.tasks.filter((x) => x.included).length, filter_from_category: "" },
            ranking.pilots.map((p) =>
              el(
                "FsParticipant",
                { id: p.pilot, points: r1(p.total), rank: p.rank },
                Object.entries(p.tasks).map(([taskId, ts]) => {
                  const number = st.tasks.find((x) => String(x.t.id) === taskId)?.t.number ?? taskId;
                  return el("FsTask", { id: number, points: r1(ts?.score), counting_points: r1(ts?.counted), counts: ts?.counted ? 1 : 0 });
                }),
              ),
            ),
          ),
        ]),
      ]
    : [];
  const cats = a.rankings.map((r) => category(r.name, r.rule)).filter((x): x is string => x !== null);
  const compEl = el(
    "FsCompetition",
    {
      id: comp.id,
      name: a.competition.name,
      location: a.competition.location ?? "",
      from: a.competition.start_date ?? "",
      to: a.competition.end_date ?? "",
      discipline: "pg",
      utc_offset: utcOffset,
      ftv_factor: s.ftvFactor,
    },
    [
      formula(s),
      cdata("FsCompetitionNotes", t("Exporté de pgscore le {date}.", { date: new Date().toISOString().slice(0, 10) })),
      el("FsParticipants", {}, participants),
      el("FsTasks", {}, tasks),
      ...compResults,
      ...(cats.length ? [el("FsCompCategories", {}, cats)] : []),
    ],
  );
  return `<?xml version="1.0" encoding="utf-8"?>\r\n${el("Fs", { version: "3.5", comment: "Exported by pgscore" }, [compEl])}\r\n`;
}

/** ZIP pour FS : le .fsdb et les traces rangées comme FS les range (tracks\T01\fichier.igc). */
export function competitionFsdbZip(db: Db, store: TrackStore, comp: CompetitionRow, fileName: string): Uint8Array {
  const a = competitionArchive(db, comp);
  const files: Zippable = { [fileName]: strToU8(competitionFsdb(db, comp, { withTracks: true })) };
  for (const tk of a.tasks) for (const tr of tk.tracks) files[`tracks/T${String(tk.number).padStart(2, "0")}/${tr.filename}`] = [store.bytes(tr.sha256), { level: 1 }];
  return zipSync(files);
}
