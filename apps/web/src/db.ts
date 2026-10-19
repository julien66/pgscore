import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Base SQLite de l'appli. Un seul fichier, migrations appliquées à l'ouverture. */
export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
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
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  for (; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[version]!);
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
}

export interface TrackRow {
  id: number;
  task_id: number;
  pilot_key: string;
  pilot_name: string | null;
  filename: string;
  uploaded_at: number;
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
}
