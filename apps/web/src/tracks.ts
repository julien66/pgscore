import type { Db, TrackHistoryRow, TrackRow } from "./db.js";

/**
 * Traces d'une manche. Une seule trace en vigueur par pilote ; celle qu'elle remplace (ou une trace
 * retirée) passe dans l'historique avec l'auteur, l'heure et la raison. Les fichiers restent dans le
 * dossier des traces : rien n'est perdu.
 */

const archive = (db: Db, old: TrackRow, userId: number, how: "replaced" | "removed") =>
  db
    .prepare(
      `INSERT INTO track_history (task_id, pilot_key, pilot_name, filename, sha256, size, uploaded_at, uploaded_by, note, ended_at, ended_by, ended_how)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(old.task_id, old.pilot_key, old.pilot_name, old.filename, old.sha256, old.size, old.uploaded_at, old.uploaded_by, old.note, Date.now(), userId, how);

export interface NewTrack {
  pilotKey: string;
  pilotName: string | null;
  filename: string;
  sha256: string;
  size: number;
  note?: string | null;
}

/** Enregistre la trace d'un pilote. Rend "same" si c'est déjà ce fichier-là, "replaced" ou "added". */
export function saveTrack(db: Db, taskId: number, userId: number, t: NewTrack): "added" | "replaced" | "same" {
  const old = db.prepare("SELECT * FROM tracks WHERE task_id = ? AND pilot_key = ?").get(taskId, t.pilotKey) as unknown as TrackRow | undefined;
  if (old && old.sha256 === t.sha256) return "same";
  if (old) {
    archive(db, old, userId, "replaced");
    db.prepare("UPDATE tracks SET pilot_name = ?, filename = ?, sha256 = ?, size = ?, uploaded_at = ?, uploaded_by = ?, note = ? WHERE id = ?").run(
      t.pilotName ?? old.pilot_name,
      t.filename,
      t.sha256,
      t.size,
      Date.now(),
      userId,
      t.note ?? null,
      old.id,
    );
    return "replaced";
  }
  db.prepare("INSERT INTO tracks (task_id, pilot_key, pilot_name, filename, sha256, size, uploaded_at, uploaded_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    taskId,
    t.pilotKey,
    t.pilotName,
    t.filename,
    t.sha256,
    t.size,
    Date.now(),
    userId,
    t.note ?? null,
  );
  return "added";
}

export function removeTrack(db: Db, taskId: number, trackId: number, userId: number): boolean {
  const old = db.prepare("SELECT * FROM tracks WHERE id = ? AND task_id = ?").get(trackId, taskId) as unknown as TrackRow | undefined;
  if (!old) return false;
  archive(db, old, userId, "removed");
  db.prepare("DELETE FROM tracks WHERE id = ?").run(old.id);
  return true;
}

export function trackHistory(db: Db, taskId: number): TrackHistoryRow[] {
  return db
    .prepare(
      `SELECT h.*, u1.name AS uploaded_by_name, u2.name AS ended_by_name FROM track_history h
       LEFT JOIN users u1 ON u1.id = h.uploaded_by LEFT JOIN users u2 ON u2.id = h.ended_by
       WHERE h.task_id = ? ORDER BY h.ended_at DESC, h.id DESC`,
    )
    .all(taskId) as unknown as TrackHistoryRow[];
}

/** Vrai si ce fichier appartient à la manche (trace en vigueur ou historique). */
export function taskHasFile(db: Db, taskId: number, sha256: string): { filename: string } | null {
  return (
    (db.prepare("SELECT filename FROM tracks WHERE task_id = ? AND sha256 = ? UNION ALL SELECT filename FROM track_history WHERE task_id = ? AND sha256 = ? LIMIT 1").get(
      taskId,
      sha256,
      taskId,
      sha256,
    ) as { filename: string } | undefined) ?? null
  );
}
