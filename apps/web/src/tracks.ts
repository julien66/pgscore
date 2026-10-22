import type { Db, PilotRow, TrackHistoryRow, TrackRow } from "./db.js";
import { learnFilenameConvention, pilotKeyForTrack } from "./files.js";
import type { TrackStore } from "./track-store.js";
import type { VersionMeta } from "./viewer-data.js";

/**
 * Traces d'une manche. Un pilote peut avoir plusieurs traces en vigueur (le calcul retient la plus
 * favorable) ; une trace remplacée ou retirée passe dans l'historique avec l'auteur, l'heure et la raison. Les fichiers restent dans le
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

const insert = (db: Db, taskId: number, userId: number, t: NewTrack) =>
  db
    .prepare("INSERT INTO tracks (task_id, pilot_key, pilot_name, filename, sha256, size, uploaded_at, uploaded_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(taskId, t.pilotKey, t.pilotName, t.filename, t.sha256, t.size, Date.now(), userId, t.note ?? null);

/**
 * Enregistre une trace envoyée pour un pilote. Si le pilote en a déjà une autre, elle ne la remplace
 * pas : les deux sont gardées et le calcul retient la plus favorable au pilote ("extra").
 * Rend "same" si ce fichier est déjà une trace du pilote.
 */
export function saveTrack(db: Db, taskId: number, userId: number, t: NewTrack): "added" | "extra" | "same" {
  const olds = db.prepare("SELECT sha256 FROM tracks WHERE task_id = ? AND pilot_key = ?").all(taskId, t.pilotKey) as Array<{ sha256: string }>;
  if (olds.some((o) => o.sha256 === t.sha256)) return "same";
  insert(db, taskId, userId, t);
  return olds.length ? "extra" : "added";
}

/** Remplace une trace précise (bouton « Remplacer ») : l'ancienne passe dans l'historique. */
export function replaceTrack(db: Db, taskId: number, trackId: number, userId: number, t: Omit<NewTrack, "pilotKey">): "replaced" | "same" {
  const old = db.prepare("SELECT * FROM tracks WHERE id = ? AND task_id = ?").get(trackId, taskId) as unknown as TrackRow | undefined;
  if (!old) throw new Error("trace inconnue");
  const twin = db.prepare("SELECT id FROM tracks WHERE task_id = ? AND pilot_key = ? AND sha256 = ?").get(taskId, old.pilot_key, t.sha256) as { id: number } | undefined;
  if (twin) return "same";
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

export function removeTrack(db: Db, taskId: number, trackId: number, userId: number): boolean {
  const old = db.prepare("SELECT * FROM tracks WHERE id = ? AND task_id = ?").get(trackId, taskId) as unknown as TrackRow | undefined;
  if (!old) return false;
  archive(db, old, userId, "removed");
  db.prepare("DELETE FROM tracks WHERE id = ?").run(old.id);
  return true;
}

/** Retire d'un coup toutes les traces en vigueur de la manche : chacune passe dans l'historique. Rend le nombre retiré. */
export function removeAllTracks(db: Db, taskId: number, userId: number): number {
  const olds = db.prepare("SELECT * FROM tracks WHERE task_id = ?").all(taskId) as unknown as TrackRow[];
  db.exec("BEGIN");
  try {
    for (const old of olds) archive(db, old, userId, "removed");
    db.prepare("DELETE FROM tracks WHERE task_id = ?").run(taskId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return olds.length;
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

/** Toutes les versions de la trace d'un pilote : celle en vigueur d'abord, puis les anciennes, de la plus récente à la plus ancienne. */
export function pilotVersions(db: Db, taskId: number, pilotKey: string, scoredSha?: string): Array<{ meta: VersionMeta; pilotName: string | null }> {
  const curs = db
    .prepare("SELECT t.*, u.name AS by_name FROM tracks t LEFT JOIN users u ON u.id = t.uploaded_by WHERE t.task_id = ? AND t.pilot_key = ? ORDER BY t.uploaded_at DESC, t.id DESC")
    .all(taskId, pilotKey) as unknown as Array<TrackRow & { by_name: string | null }>;
  // La trace retenue au dernier calcul d'abord.
  curs.sort((a, b) => Number(b.sha256 === scoredSha) - Number(a.sha256 === scoredSha));
  const old = trackHistory(db, taskId).filter((h) => h.pilot_key === pilotKey);
  const out: Array<{ meta: VersionMeta; pilotName: string | null }> = [];
  for (const cur of curs) {
    out.push({
      pilotName: cur.pilot_name,
      meta: { sha256: cur.sha256, filename: cur.filename, uploadedAt: cur.uploaded_at, uploadedBy: cur.by_name, status: "current", endedAt: null, endedBy: null, note: cur.note },
    });
  }
  for (const h of old) {
    // Un fichier renvoyé après avoir été remplacé n'apparaît qu'une fois.
    if (out.some((o) => o.meta.sha256 === h.sha256)) continue;
    out.push({
      pilotName: h.pilot_name,
      meta: { sha256: h.sha256, filename: h.filename, uploadedAt: h.uploaded_at, uploadedBy: h.uploaded_by_name, status: h.ended_how, endedAt: h.ended_at, endedBy: h.ended_by_name, note: h.note },
    });
  }
  return out;
}

/**
 * Rattache une trace à un pilote inscrit (son numéro dans la vue des pilotes de la compétition) :
 * la trace prend le numéro et le nom de l'inscrit. Rend "same" si elle est déjà à ce pilote,
 * "twin" si ce pilote a déjà ce même fichier (la trace en double est alors retirée).
 */
export function assignTrack(db: Db, taskId: number, trackId: number, userId: number, pilot: { pilot_key: string; name: string }): "moved" | "same" | "twin" | "unknown" {
  const tr = db.prepare("SELECT * FROM tracks WHERE id = ? AND task_id = ?").get(trackId, taskId) as unknown as TrackRow | undefined;
  if (!tr) return "unknown";
  if (tr.pilot_key === pilot.pilot_key) {
    if (tr.pilot_name !== pilot.name) db.prepare("UPDATE tracks SET pilot_name = ? WHERE id = ?").run(pilot.name, tr.id);
    return "same";
  }
  const twin = db.prepare("SELECT id FROM tracks WHERE task_id = ? AND pilot_key = ? AND sha256 = ?").get(taskId, pilot.pilot_key, tr.sha256);
  if (twin) {
    removeTrack(db, taskId, tr.id, userId);
    return "twin";
  }
  db.prepare("UPDATE tracks SET pilot_key = ?, pilot_name = ? WHERE id = ?").run(pilot.pilot_key, pilot.name, tr.id);
  return "moved";
}

/**
 * Rattache aux pilotes inscrits les traces de la manche qui ne le sont pas encore (envoyées avant
 * l'inscription, ou avec une liste incomplète) : même règle qu'à l'envoi (HFCID, numéro du fichier selon
 * la convention de nommage de la manche, nom de l'en-tête ou du fichier). Remet aussi le nom de l'inscrit sur les traces déjà rattachées. Rend le nombre de traces rattachées.
 */
export function linkTracks(db: Db, store: TrackStore, taskId: number, userId: number, registry: PilotRow[]): number {
  if (!registry.length) return 0;
  const reg = new Map(registry.map((p) => [p.pilot_key, p]));
  const rows = db.prepare("SELECT * FROM tracks WHERE task_id = ? ORDER BY id").all(taskId) as unknown as TrackRow[];
  // Convention de nommage apprise sur toutes les traces de la manche : les rattachées confirment la place du numéro.
  const texts = new Map<number, string>();
  for (const tr of rows) {
    if (reg.has(tr.pilot_key)) continue;
    try {
      texts.set(tr.id, store.text(tr.sha256));
    } catch {
      // Fichier manquant : la trace reste comme elle est.
    }
  }
  const conv = learnFilenameConvention(
    rows.map((tr) => (reg.has(tr.pilot_key) ? { filename: tr.filename, knownId: tr.pilot_key } : { filename: tr.filename, text: texts.get(tr.id) })),
    registry,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const tr of rows) {
      const own = reg.get(tr.pilot_key);
      if (own) {
        if (tr.pilot_name !== own.name) db.prepare("UPDATE tracks SET pilot_name = ? WHERE id = ?").run(own.name, tr.id);
        continue;
      }
      const text = texts.get(tr.id);
      if (text === undefined) continue;
      const key = pilotKeyForTrack(tr.filename, text, registry, new Map(), conv);
      const p = reg.get(key);
      if (!p) continue;
      const r = assignTrack(db, taskId, tr.id, userId, p);
      if (r === "moved" || r === "twin") n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

