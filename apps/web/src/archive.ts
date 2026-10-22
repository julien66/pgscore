import { createHash } from "node:crypto";
import { strFromU8, strToU8 } from "fflate";
import { taskDistances, type DecisionKind } from "@pgscore/engine";
import type { CompetitionRow, Db, DecisionRow, RunRow, TaskRow, TrackRow } from "./db.js";
import { DECISION_KINDS } from "./decisions.js";
import { t } from "./i18n.js";
import { cleanPilot, listPilots, PILOT_COLUMNS, type PilotFields } from "./pilots.js";
import { listRankings, RULE_FIELDS, RULE_OPS, type RankingRule } from "./rankings.js";
import { DEFAULT_SETTINGS, FormError, parseSettings, type CompetitionSettings, type StoredTask } from "./settings.js";
import type { TrackStore } from "./track-store.js";
import { latestDoneRun, queryAll, tasksOf, tracksOf } from "./repo.js";
import { isZipHead, sourceBytes, sourceHead, ZipReader, zipStream, type ZipSource } from "./zip.js";

/**
 * Archive d'une compétition complète (format « pgscore-competition », version 1) : un ZIP avec
 * competition.json (réglages, espace aérien, pilotes, classements, manches, décisions, traces et
 * derniers résultats) et les fichiers IGC tels que reçus, rangés sous tracks/m<numéro>/<empreinte>.igc.
 * Réimportée, elle redonne la même compétition, résultats compris, sans relancer de calcul.
 */
export const ARCHIVE_FORMAT = "pgscore-competition";
export const ARCHIVE_VERSION = 1;

export interface ArchiveTrack {
  pilot_key: string;
  pilot_name: string | null;
  filename: string;
  sha256: string;
  size: number;
  uploaded_at: number;
  note: string | null;
  /** Chemin du fichier dans l'archive (absent si l'export a été fait sans les traces). */
  file?: string;
}

export interface ArchiveTask {
  number: number;
  date: string | null;
  official: boolean;
  source: string;
  source_text: string;
  task: StoredTask;
  scoring_changed_at: number | null;
  decisions: Array<{ pilot_key: string; pilot_name: string | null; kind: DecisionKind; value: number | null; reason: string; created_at: number }>;
  tracks: ArchiveTrack[];
  /** Derniers résultats calculés (sortie du moteur), avec les dates du calcul. */
  result: { started_at: number; finished_at: number | null; results: unknown } | null;
}

export interface CompetitionArchive {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exported_at: string;
  competition: {
    name: string;
    location: string | null;
    start_date: string | null;
    end_date: string | null;
    settings: CompetitionSettings;
    airspace: { name: string | null; text: string } | null;
  };
  pilots: PilotFields[];
  rankings: Array<{ name: string; rule: RankingRule; overrides: Array<{ pilot_key: string; included: boolean }> }>;
  tasks: ArchiveTask[];
}

/** Contenu de competition.json pour une compétition. */
export function competitionArchive(db: Db, comp: CompetitionRow): CompetitionArchive {
  const tasks = tasksOf(db, comp.id);
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exported_at: new Date().toISOString(),
    competition: {
      name: comp.name,
      location: comp.location,
      start_date: comp.start_date,
      end_date: comp.end_date,
      settings: parseSettings(comp.params),
      airspace: comp.airspace_text ? { name: comp.airspace_name, text: comp.airspace_text } : null,
    },
    pilots: listPilots(db, comp.id).map(({ id: _id, competition_id: _c, ...p }) => p),
    rankings: listRankings(db, comp.id).map((r) => ({
      name: r.row.name,
      rule: r.rule,
      overrides: [...r.overrides].map(([pilot_key, included]) => ({ pilot_key, included })),
    })),
    tasks: tasks.map((tk) => {
      const run = latestDoneRun(db, tk.id);
      return {
        number: tk.number,
        date: tk.date,
        official: tk.official === 1,
        source: tk.source,
        source_text: tk.source_text,
        task: JSON.parse(tk.task) as StoredTask,
        scoring_changed_at: tk.scoring_changed_at,
        decisions: queryAll<DecisionRow>(db, "SELECT * FROM task_decisions WHERE task_id = ? ORDER BY id", tk.id).map((d) => ({
          pilot_key: d.pilot_key,
          pilot_name: d.pilot_name,
          kind: d.kind,
          value: d.value,
          reason: d.reason,
          created_at: d.created_at,
        })),
        tracks: tracksOf(db, tk.id).map((tr) => ({
          pilot_key: tr.pilot_key,
          pilot_name: tr.pilot_name,
          filename: tr.filename,
          sha256: tr.sha256,
          size: tr.size,
          uploaded_at: tr.uploaded_at,
          note: tr.note,
        })),
        result: run?.results ? { started_at: run.started_at, finished_at: run.finished_at, results: JSON.parse(run.results) } : null,
      };
    }),
  };
}

/** ZIP de la compétition, construit au fil de l'envoi. Sans les traces, seul competition.json est mis (résultats compris). */
export function exportCompetition(db: Db, store: TrackStore, comp: CompetitionRow, opts: { tracks: boolean }): ReadableStream<Uint8Array> {
  const a = competitionArchive(db, comp);
  const files: Array<{ name: string; data: () => Uint8Array; level?: 1 }> = [];
  if (opts.tracks)
    for (const tk of a.tasks)
      for (const tr of tk.tracks) {
        tr.file = `tracks/m${tk.number}/${tr.sha256}.igc`;
        // Compression rapide : une archive de plusieurs centaines de traces se construit en quelques secondes.
        files.push({ name: tr.file, data: () => store.bytes(tr.sha256), level: 1 });
      }
  files.push({ name: "competition.json", data: () => strToU8(JSON.stringify(a, null, 2)) });
  return zipStream(files);
}

// --- Import --------------------------------------------------------------------------------

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const isDate = (v: unknown) => v === null || v === undefined || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));

function bad(what: string): never {
  throw new FormError(t("Archive invalide : {what}", { what }));
}

/**
 * Lit l'archive (ZIP, ou competition.json seul) et vérifie sa forme. Le ZIP est lu fichier par fichier ;
 * avec `store`, chaque trace est rangée tout de suite dans le dossier des traces au lieu d'être gardée en
 * mémoire (une archive de plusieurs centaines de traces ne tient jamais entière en mémoire).
 */
export function readArchive(src: ZipSource, store?: TrackStore): { a: CompetitionArchive; files: Record<string, ArchiveFile> } {
  if (!isZipHead(sourceHead(src, 2))) return { a: parseArchiveJson(sourceBytes(src)), files: {} };
  let zip: ZipReader;
  try {
    zip = ZipReader.open(src);
  } catch (e) {
    bad((e as Error).message);
  }
  try {
    if (!zip.has("competition.json")) bad(t("competition.json manquant"));
    const a = parseArchiveJson(readZipFile(zip, "competition.json"));
    // Seules les traces citées par competition.json sont lues, une à une.
    const files: Record<string, ArchiveFile> = {};
    for (const tk of a.tasks ?? [])
      for (const tr of Array.isArray(tk?.tracks) ? tk.tracks : []) {
        const name = tr?.file ?? `tracks/m${Number(tk?.number)}/${tr?.sha256}.igc`;
        if (typeof name !== "string" || name in files || !zip.has(name)) continue;
        const data = readZipFile(zip, name);
        files[name] = store ? { stored: store.put(data), size: data.length } : data;
      }
    return { a, files };
  } finally {
    zip.close();
  }
}

function readZipFile(zip: ZipReader, name: string): Uint8Array {
  try {
    return zip.file(name);
  } catch (e) {
    bad((e as Error).message);
  }
}

function parseArchiveJson(json: Uint8Array): CompetitionArchive {
  let a: CompetitionArchive;
  try {
    a = JSON.parse(strFromU8(json)) as CompetitionArchive;
  } catch (e) {
    bad((e as Error).message);
  }
  if (a?.format !== ARCHIVE_FORMAT) bad(t("format « {f} » attendu", { f: ARCHIVE_FORMAT }));
  if (typeof a.version !== "number" || a.version > ARCHIVE_VERSION) bad(t("version {v} non prise en charge", { v: String(a.version) }));
  const c = a.competition;
  if (!c || !str(c.name)) bad(t("nom de la compétition manquant"));
  if (!isDate(c.start_date) || !isDate(c.end_date)) bad(t("dates attendues au format AAAA-MM-JJ"));
  if (!Array.isArray(a.pilots ?? []) || !Array.isArray(a.rankings ?? []) || !Array.isArray(a.tasks ?? [])) bad(t("listes attendues"));
  return a;
}

/** Réglages connus seulement, avec les valeurs par défaut pour ceux qui manquent. */
function cleanSettings(raw: unknown): CompetitionSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === "object")
    for (const [k, v] of Object.entries(raw)) if (k in DEFAULT_SETTINGS && typeof v === typeof (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]) out[k] = v;
  return out as unknown as CompetitionSettings;
}

function cleanRule(rule: unknown, where: string): RankingRule {
  const conds = (rule as RankingRule | null)?.conditions;
  if (!Array.isArray(conds)) bad(where);
  for (const x of conds) if (!(x.field in RULE_FIELDS) || !(x.op in RULE_OPS) || typeof x.value !== "string") bad(where);
  return { conditions: conds.map((x) => ({ field: x.field, op: x.op, value: x.value })) };
}

/**
 * Crée une nouvelle compétition à partir d'une archive, pour l'utilisateur donné. Les traces dont le
 * fichier manque dans l'archive sont ignorées (et comptées) ; un fichier dont l'empreinte ne correspond
 * pas fait échouer l'import. Tout est écrit en une transaction.
 */
export function importCompetition(db: Db, store: TrackStore, userId: number, src: ZipSource): ImportReport {
  const { a, files } = readArchive(src, store);
  return writeArchive(db, store, userId, a, files);
}

export interface ImportReport {
  id: number;
  tasks: number;
  pilots: number;
  tracks: number;
  missingTracks: number;
  results: number;
  /** Ce qui n'a pas pu être repris tel quel (import FSDB). */
  warnings?: string[];
}

/** Écrit une compétition décrite comme une archive (fichiers IGC rangés sous leur chemin dans `files`). */
/** Fichier d'une archive : ses octets, ou une trace déjà rangée dans le dossier des traces (gros imports). */
export type ArchiveFile = Uint8Array | { stored: string; size: number };

export function writeArchive(db: Db, store: TrackStore, userId: number, a: CompetitionArchive, files: Record<string, ArchiveFile>): ImportReport {
  const c = a.competition;
  const pilots = (a.pilots ?? []).map((p, i) => {
    try {
      return cleanPilot(Object.fromEntries(PILOT_COLUMNS.map((col) => [col.key, (p as Record<string, unknown>)[col.key] ?? null])));
    } catch (e) {
      bad(t("pilote n° {n} : {error}", { n: i + 1, error: (e as Error).message }));
    }
  });
  const rankings = (a.rankings ?? []).map((r, i) => {
    const where = t("classement n° {n}", { n: i + 1 });
    if (!str(r?.name)) bad(where);
    return {
      name: String(r.name),
      rule: cleanRule(r.rule, where),
      overrides: (Array.isArray(r.overrides) ? r.overrides : []).filter((o) => str(o?.pilot_key)).map((o) => ({ key: String(o.pilot_key), inc: Boolean(o.included) })),
    };
  });
  const numbers = new Set<number>();
  const tasks = (a.tasks ?? []).map((tk) => {
    const n = Number(tk?.number);
    if (!Number.isInteger(n) || n < 1 || numbers.has(n)) bad(t("numéro de manche {n}", { n: String(tk?.number) }));
    numbers.add(n);
    if (!isDate(tk.date)) bad(t("date de la manche {n}", { n }));
    try {
      taskDistances(tk.task);
    } catch (e) {
      bad(t("manche {n} : {error}", { n, error: (e as Error).message }));
    }
    for (const d of tk.decisions ?? []) if (!(d.kind in DECISION_KINDS) || !str(d.pilot_key)) bad(t("décision de la manche {n}", { n }));
    const tracks = (tk.tracks ?? []).map((tr) => {
      if (!str(tr?.pilot_key) || !/^[0-9a-f]{64}$/.test(String(tr.sha256))) bad(t("trace de la manche {n}", { n }));
      const data = files[tr.file ?? `tracks/m${n}/${tr.sha256}.igc`];
      if (data && (data instanceof Uint8Array ? createHash("sha256").update(data).digest("hex") : data.stored) !== tr.sha256)
        bad(t("le fichier de la trace {pilot} (manche {n}) ne correspond pas à son empreinte", { pilot: tr.pilot_key, n }));
      return { tr, data };
    });
    return { tk, n, tracks };
  });

  const now = Date.now();
  let trackCount = 0;
  let missing = 0;
  let results = 0;
  let compId = 0;
  db.exec("BEGIN");
  try {
    compId = Number(
      db
        .prepare(
          `INSERT INTO competitions (owner_id, name, location, start_date, end_date, params, airspace_name, airspace_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, String(c.name).trim(), str(c.location), str(c.start_date), str(c.end_date), JSON.stringify(cleanSettings(c.settings)), str(c.airspace?.name), str(c.airspace?.text), now)
        .lastInsertRowid,
    );
    const fields = PILOT_COLUMNS.map((col) => col.key);
    const insPilot = db.prepare(
      `INSERT OR REPLACE INTO competition_pilots (competition_id, ${fields.join(", ")}) VALUES (?, ${fields.map(() => "?").join(", ")})`,
    );
    for (const p of pilots) insPilot.run(compId, ...fields.map((f) => p[f]));
    const rk = db.prepare("INSERT INTO competition_rankings (competition_id, name, rule, created_at) VALUES (?, ?, ?, ?)");
    const ov = db.prepare("INSERT OR REPLACE INTO ranking_overrides (ranking_id, pilot_key, included) VALUES (?, ?, ?)");
    for (const x of rankings) {
      const id = Number(rk.run(compId, x.name, JSON.stringify(x.rule), now).lastInsertRowid);
      for (const o of x.overrides) ov.run(id, o.key, o.inc ? 1 : 0);
    }
    const insTask = db.prepare(
      "INSERT INTO tasks (competition_id, number, date, source, source_text, task, created_at, scoring_changed_at, official) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insDec = db.prepare(
      "INSERT INTO task_decisions (task_id, pilot_key, pilot_name, kind, value, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insTrack = db.prepare(
      "INSERT INTO tracks (task_id, pilot_key, pilot_name, filename, sha256, size, uploaded_at, uploaded_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insRun = db.prepare(
      "INSERT INTO runs (task_id, status, done, total, results, started_by, started_at, finished_at) VALUES (?, 'done', ?, ?, ?, ?, ?, ?)",
    );
    for (const { tk, n, tracks } of tasks) {
      const taskId = Number(
        insTask.run(compId, n, str(tk.date), String(tk.source ?? "import"), String(tk.source_text ?? ""), JSON.stringify(tk.task), now, tk.scoring_changed_at ?? null, tk.official ? 1 : 0)
          .lastInsertRowid,
      );
      for (const d of tk.decisions ?? [])
        insDec.run(taskId, String(d.pilot_key), str(d.pilot_name), d.kind, d.value === null || d.value === undefined ? null : Number(d.value), String(d.reason ?? ""), userId, Number(d.created_at) || now);
      for (const { tr, data } of tracks) {
        if (!data) {
          missing++;
          continue;
        }
        const size = data instanceof Uint8Array ? (store.put(data), data.length) : data.size;
        insTrack.run(taskId, String(tr.pilot_key), str(tr.pilot_name), String(tr.filename || `${tr.pilot_key}.igc`), tr.sha256, size, Number(tr.uploaded_at) || now, userId, str(tr.note));
        trackCount++;
      }
      if (tk.result?.results) {
        const res = tk.result.results as { pilots?: unknown[] };
        const total = Array.isArray(res.pilots) ? res.pilots.length : 0;
        insRun.run(taskId, total, total, JSON.stringify(tk.result.results), userId, Number(tk.result.started_at) || now, Number(tk.result.finished_at) || now);
        results++;
      }
    }
    db.exec("COMMIT");
    return { id: compId, tasks: tasks.length, pilots: pilots.length, tracks: trackCount, missingTracks: missing, results };
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
