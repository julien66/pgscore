import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DecisionKind } from "@pgscore/engine";
import type { TrackStore } from "./track-store.js";
import { registerTrackPilots } from "./pilots.js";

/** Base SQLite de l'appli. Un seul fichier, migrations appliquées à l'ouverture. */
export type Db = DatabaseSync;

type Migration = string | ((db: Db, tracks: TrackStore) => void);

export const MIGRATIONS: Migration[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     provider TEXT NOT NULL,
     subject TEXT NOT NULL,
     email TEXT,
     name TEXT,
     created_at INTEGER NOT NULL,
     UNIQUE (provider, subject)
   );
   CREATE TABLE sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE login_states (
     state TEXT PRIMARY KEY,
     verifier TEXT NOT NULL,
     nonce TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE competitions (
     id INTEGER PRIMARY KEY,
     owner_id INTEGER NOT NULL REFERENCES users(id),
     name TEXT NOT NULL,
     location TEXT,
     start_date TEXT,
     end_date TEXT,
     params TEXT NOT NULL,
     airspace_name TEXT,
     airspace_text TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE tasks (
     id INTEGER PRIMARY KEY,
     competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
     number INTEGER NOT NULL,
     date TEXT,
     source TEXT NOT NULL,
     source_text TEXT NOT NULL,
     task TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE tracks (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     pilot_key TEXT NOT NULL,
     pilot_name TEXT,
     filename TEXT NOT NULL,
     igc TEXT NOT NULL,
     uploaded_at INTEGER NOT NULL,
     UNIQUE (task_id, pilot_key)
   );
   CREATE TABLE runs (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     status TEXT NOT NULL,
     done INTEGER NOT NULL DEFAULT 0,
     total INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     results TEXT,
     started_by INTEGER REFERENCES users(id),
     started_at INTEGER NOT NULL,
     finished_at INTEGER
   );`,
  // Les fichiers IGC quittent la base : ils sont rangés par empreinte dans le dossier des traces.
  (db, tracks) => {
    db.exec(`CREATE TABLE tracks_new (
       id INTEGER PRIMARY KEY,
       task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
       pilot_key TEXT NOT NULL,
       pilot_name TEXT,
       filename TEXT NOT NULL,
       sha256 TEXT NOT NULL,
       size INTEGER NOT NULL,
       uploaded_at INTEGER NOT NULL,
       UNIQUE (task_id, pilot_key)
     )`);
    const rows = db.prepare("SELECT id, task_id, pilot_key, pilot_name, filename, igc, uploaded_at FROM tracks").all() as Array<{
      id: number; task_id: number; pilot_key: string; pilot_name: string | null; filename: string; igc: string; uploaded_at: number;
    }>;
    const put = db.prepare("INSERT INTO tracks_new (id, task_id, pilot_key, pilot_name, filename, sha256, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const r of rows) {
      // Seul le texte décodé était gardé : les octets d'origine sont reconstitués (identiques pour un IGC en ASCII).
      const bytes = /^[\u0000-\u00ff]*$/.test(r.igc) ? Buffer.from(r.igc, "latin1") : Buffer.from(r.igc, "utf8");
      put.run(r.id, r.task_id, r.pilot_key, r.pilot_name, r.filename, tracks.put(bytes), bytes.length, r.uploaded_at);
    }
    db.exec("DROP TABLE tracks; ALTER TABLE tracks_new RENAME TO tracks;");
  },
  // Historique des traces : une trace remplacée ou retirée y est gardée, avec qui, quand et pourquoi.
  `ALTER TABLE tracks ADD COLUMN uploaded_by INTEGER REFERENCES users(id);
   ALTER TABLE tracks ADD COLUMN note TEXT;
   CREATE TABLE track_history (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     pilot_key TEXT NOT NULL,
     pilot_name TEXT,
     filename TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     size INTEGER NOT NULL,
     uploaded_at INTEGER NOT NULL,
     uploaded_by INTEGER REFERENCES users(id),
     note TEXT,
     ended_at INTEGER NOT NULL,
     ended_by INTEGER REFERENCES users(id),
     ended_how TEXT NOT NULL CHECK (ended_how IN ('replaced', 'removed'))
   );
   CREATE INDEX track_history_task ON track_history (task_id, pilot_key);`,
  // Suivi du calcul : étape en cours et détail (pilote en cours, compteurs), relus par la page.
  `ALTER TABLE runs ADD COLUMN step TEXT;
   ALTER TABLE runs ADD COLUMN detail TEXT;`,
  // Décisions de l'organisateur (bonus, pénalités, goal accordé, ABS/DNF…) et date du dernier changement
  // de ce qui entre dans les points, pour signaler un classement à relancer.
  `CREATE TABLE task_decisions (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     pilot_key TEXT NOT NULL,
     pilot_name TEXT,
     kind TEXT NOT NULL,
     value REAL,
     reason TEXT NOT NULL,
     created_by INTEGER REFERENCES users(id),
     created_at INTEGER NOT NULL
   );
   CREATE INDEX task_decisions_task ON task_decisions(task_id);
   ALTER TABLE tasks ADD COLUMN scoring_changed_at INTEGER;`,
  // Manche officielle : ses derniers résultats comptent au classement général.
  `ALTER TABLE tasks ADD COLUMN official INTEGER NOT NULL DEFAULT 0;`,
  // Pilotes inscrits à la compétition (import FSDB ou CSV, ou saisie) : ils servent aux classements extraits.
  `CREATE TABLE competition_pilots (
     id INTEGER PRIMARY KEY,
     competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
     pilot_key TEXT NOT NULL,
     name TEXT NOT NULL,
     gender TEXT,
     nation TEXT,
     civl_id TEXT,
     glider_brand TEXT,
     glider_model TEXT,
     glider_class TEXT,
     harness_brand TEXT,
     harness_model TEXT,
     weight_max REAL,
     UNIQUE (competition_id, pilot_key)
   );`,
  // Classements extraits du général (féminin, serial…) : règle sur les données pilotes, plus des
  // pilotes ajoutés ou retirés à la main.
  `CREATE TABLE competition_rankings (
     id INTEGER PRIMARY KEY,
     competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     rule TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE ranking_overrides (
     ranking_id INTEGER NOT NULL REFERENCES competition_rankings(id) ON DELETE CASCADE,
     pilot_key TEXT NOT NULL,
     included INTEGER NOT NULL,
     PRIMARY KEY (ranking_id, pilot_key)
   );
   INSERT INTO competition_rankings (competition_id, name, rule, created_at)
     SELECT id, 'Féminin', '{"conditions":[{"field":"gender","op":"in","value":"F"}]}', created_at FROM competitions;`,
  // Sponsor du pilote, affiché dans les classements.
  `ALTER TABLE competition_pilots ADD COLUMN sponsor TEXT;`,
  // Clés d'API personnelles, pour l'accès par programme (import et export de compétitions).
  `CREATE TABLE api_tokens (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );`,
  // Plusieurs traces par pilote (deux instruments, fichier renvoyé) : le calcul retient la plus favorable.
  `CREATE TABLE tracks_new (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     pilot_key TEXT NOT NULL,
     pilot_name TEXT,
     filename TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     size INTEGER NOT NULL,
     uploaded_at INTEGER NOT NULL,
     uploaded_by INTEGER REFERENCES users(id),
     note TEXT,
     UNIQUE (task_id, pilot_key, sha256)
   );
   INSERT INTO tracks_new (id, task_id, pilot_key, pilot_name, filename, sha256, size, uploaded_at, uploaded_by, note)
     SELECT id, task_id, pilot_key, pilot_name, filename, sha256, size, uploaded_at, uploaded_by, note FROM tracks;
   DROP TABLE tracks;
   ALTER TABLE tracks_new RENAME TO tracks;
   CREATE INDEX tracks_task_pilot ON tracks (task_id, pilot_key);`,
  // Pilotes des traces déjà envoyées inscrits d'office dans la liste de leur compétition.
  (db) => {
    for (const { id } of db.prepare("SELECT id FROM competitions").all() as Array<{ id: number }>) registerTrackPilots(db, id);
  },
  // Dernier calcul (terminé) d'une manche et manches d'une compétition, cherchés à chaque page.
  `CREATE INDEX runs_task_status ON runs (task_id, status);
   CREATE INDEX tasks_competition ON tasks (competition_id);`,
  // Anciens calculs jamais montrés : seuls restent le dernier de chaque manche et son dernier terminé (repo.ts, purgeRuns).
  `DELETE FROM runs
    WHERE id NOT IN (SELECT MAX(id) FROM runs GROUP BY task_id)
      AND id NOT IN (SELECT MAX(id) FROM runs WHERE status = 'done' GROUP BY task_id);`,
  // Données d'un service externe sur les manches (satisfaction, incidents), envoyées avec une clé
  // propre à la compétition (reports.ts). Chaque élément est gardé tel que reçu.
  `CREATE TABLE ingest_keys (
     id INTEGER PRIMARY KEY,
     competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     created_by INTEGER REFERENCES users(id),
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );
   CREATE TABLE task_reports (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     type TEXT,
     external_id TEXT,
     payload TEXT NOT NULL,
     key_id INTEGER REFERENCES ingest_keys(id) ON DELETE SET NULL,
     received_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX task_reports_task ON task_reports (task_id, type, external_id);`,
];

export function openDb(path: string, tracks: TrackStore): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  for (; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    const m = MIGRATIONS[version]!;
    if (typeof m === "string") db.exec(m);
    else m(db, tracks);
    db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    db.exec("COMMIT");
  }
  // Un calcul interrompu par un redémarrage ne reprendra pas tout seul.
  db.prepare("UPDATE runs SET status = 'error', error = 'Interrompu par un redémarrage du serveur.' WHERE status IN ('queued', 'running')").run();
  return db;
}

export interface User {
  id: number;
  provider: string;
  subject: string;
  email: string | null;
  name: string | null;
}

export interface CompetitionRow {
  id: number;
  owner_id: number;
  name: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  params: string;
  airspace_name: string | null;
  airspace_text: string | null;
  created_at: number;
}

export interface TaskRow {
  id: number;
  competition_id: number;
  number: number;
  date: string | null;
  source: string;
  source_text: string;
  task: string;
  created_at: number;
  /** Dernier changement des réglages ou décisions qui entrent dans les points. */
  scoring_changed_at: number | null;
  /** 1 si la manche compte au classement général. */
  official: number;
}

export interface PilotRow {
  id: number;
  competition_id: number;
  pilot_key: string;
  name: string;
  gender: "F" | "M" | null;
  nation: string | null;
  civl_id: string | null;
  glider_brand: string | null;
  glider_model: string | null;
  glider_class: string | null;
  harness_brand: string | null;
  harness_model: string | null;
  weight_max: number | null;
  sponsor: string | null;
}

export interface RankingRow {
  id: number;
  competition_id: number;
  name: string;
  /** Règle en JSON (RankingRule). */
  rule: string;
  created_at: number;
}

export interface DecisionRow {
  id: number;
  task_id: number;
  pilot_key: string;
  pilot_name: string | null;
  kind: DecisionKind;
  value: number | null;
  reason: string;
  created_by: number | null;
  created_by_name?: string | null;
  created_at: number;
}

export interface TrackRow {
  id: number;
  task_id: number;
  pilot_key: string;
  pilot_name: string | null;
  filename: string;
  sha256: string;
  size: number;
  uploaded_at: number;
  uploaded_by: number | null;
  note: string | null;
}

export interface TrackHistoryRow {
  id: number;
  task_id: number;
  pilot_key: string;
  pilot_name: string | null;
  filename: string;
  sha256: string;
  size: number;
  uploaded_at: number;
  uploaded_by_name: string | null;
  note: string | null;
  ended_at: number;
  ended_by_name: string | null;
  ended_how: "replaced" | "removed";
}

export interface RunRow {
  id: number;
  task_id: number;
  status: "queued" | "running" | "done" | "error";
  done: number;
  total: number;
  error: string | null;
  results: string | null;
  started_at: number;
  finished_at: number | null;
  step: RunStep | null;
  detail: string | null;
}

/** Étapes d'un calcul, dans l'ordre. */
export const RUN_STEPS = ["prepare", "control", "leading", "save"] as const;
export type RunStep = (typeof RUN_STEPS)[number];

/** Détail de l'avancement, en JSON dans runs.detail. */
export interface RunDetail {
  airspaces?: number;
  pilot?: string;
  counts?: Record<string, number>;
  airspaceInfringements?: number;
  recent?: Array<{ name: string; status: string; distance: number; note?: string }>;
}
