import type { SQLInputValue, StatementSync } from "node:sqlite";
import type { CompetitionRow, Db, RunRow, TaskRow, TrackRow } from "./db.js";

/**
 * Accès aux données : les requêtes reprises à plusieurs endroits, typées une seule fois.
 * Les requêtes préparées sont gardées par base et par texte SQL.
 */

const cache = new WeakMap<Db, Map<string, StatementSync>>();

function stmt(db: Db, sql: string): StatementSync {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

/** Première ligne d'une requête, typée par l'appelant. */
export function queryOne<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return stmt(db, sql).get(...params) as T | undefined;
}

/** Toutes les lignes d'une requête, typées par l'appelant. */
export function queryAll<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return stmt(db, sql).all(...params) as T[];
}

export const getCompetition = (db: Db, id: number) => queryOne<CompetitionRow>(db, "SELECT * FROM competitions WHERE id = ?", id);

export const getTask = (db: Db, id: number) => queryOne<TaskRow>(db, "SELECT * FROM tasks WHERE id = ?", id);

/** Manches d'une compétition, dans l'ordre de leur numéro. */
export const tasksOf = (db: Db, competitionId: number) =>
  queryAll<TaskRow>(db, "SELECT * FROM tasks WHERE competition_id = ? ORDER BY number, id", competitionId);

/** Traces en cours d'une manche, par numéro de pilote. */
export const tracksOf = (db: Db, taskId: number) =>
  queryAll<TrackRow>(db, "SELECT * FROM tracks WHERE task_id = ? ORDER BY CAST(pilot_key AS INTEGER), pilot_key", taskId);

/** Une trace, seulement si elle appartient bien à la manche. */
export const getTrack = (db: Db, taskId: number, trackId: number) =>
  queryOne<TrackRow>(db, "SELECT * FROM tracks WHERE id = ? AND task_id = ?", trackId, taskId);

/** Dernier calcul lancé sur la manche, quel que soit son état. */
export const latestRun = (db: Db, taskId: number) => queryOne<RunRow>(db, "SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1", taskId) ?? null;

/** Un calcul terminé a toujours ses résultats. */
export type DoneRun = RunRow & { status: "done"; results: string };

/** Dernier calcul terminé de la manche : celui dont les résultats sont publiés. */
export const latestDoneRun = (db: Db, taskId: number) =>
  queryOne<DoneRun>(db, "SELECT * FROM runs WHERE task_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1", taskId) ?? null;

/**
 * Ne garde de la manche que son dernier calcul et son dernier calcul terminé : les autres ne sont jamais
 * montrés, et chacun garde tous les résultats de la manche.
 */
export function purgeRuns(db: Db, taskId: number): void {
  stmt(
    db,
    `DELETE FROM runs WHERE task_id = ?1
       AND id <> (SELECT MAX(id) FROM runs WHERE task_id = ?1)
       AND id <> COALESCE((SELECT MAX(id) FROM runs WHERE task_id = ?1 AND status = 'done'), 0)`,
  ).run(taskId);
}
