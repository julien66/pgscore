import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { t } from "./i18n.js";
import { queryAll, queryOne } from "./repo.js";

/**
 * Données reçues d'un service externe global (lié aux bots Telegram des compétitions) : satisfaction
 * des pilotes, accidents et incidents… Le service ne connaît ni nos compétitions ni nos manches : il
 * donne le nom de l'événement et une date, et nous rattachons chaque élément à une compétition (nom
 * proche, date dans ses dates ou jour d'une de ses manches) puis à la manche de ce jour-là.
 *
 * Le service s'authentifie avec une clé d'envoi (« pgsi_… ») créée par un administrateur ; elle ne
 * sert qu'à cet envoi. Chaque élément est gardé tel quel, en JSON : renvoyer un même type et un même
 * identifiant remplace l'élément. Un élément qu'on ne sait pas rattacher reste en attente : il est
 * rattaché de nouveau à la création d'une manche, ou à la main par un administrateur.
 *
 * Chaque appel authentifié est aussi gardé brut (corps tel que reçu), qu'on sache le lire ou non :
 * le format du service n'est pas encore fixé, et ses premiers envois servent à l'établir.
 */

/** Taille d'un envoi. */
export const MAX_INGEST = 5 * 1024 * 1024;
/** Éléments par envoi. */
export const MAX_INGEST_ITEMS = 10_000;
/** Appels bruts gardés (les plus récents). */
export const KEPT_REQUESTS = 200;
const MAX_LABEL = 200;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// --- Clés d'envoi du service (administrateurs) ---------------------------------------------------

export interface IngestKeyRow {
  id: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

/** Crée une clé d'envoi. Elle n'est montrée qu'une fois : seule son empreinte est gardée. */
export function createIngestKey(db: Db, userId: number, name: string): string {
  const token = `pgsi_${randomBytes(30).toString("base64url")}`;
  db.prepare("INSERT INTO ingest_keys (name, token_hash, created_by, created_at) VALUES (?, ?, ?, ?)").run(name, hash(token), userId, Date.now());
  return token;
}

export function listIngestKeys(db: Db): IngestKeyRow[] {
  return queryAll<IngestKeyRow>(db, "SELECT id, name, created_at, last_used_at FROM ingest_keys ORDER BY id DESC");
}

export function deleteIngestKey(db: Db, id: number): void {
  db.prepare("DELETE FROM ingest_keys WHERE id = ?").run(id);
}

/** Clé d'envoi reconnue. */
export function ingestKey(db: Db, token: string): { id: number } | null {
  if (!token.startsWith("pgsi_")) return null;
  const h = hash(token);
  const row = queryOne<{ id: number }>(db, "SELECT id FROM ingest_keys WHERE token_hash = ?", h);
  if (row) db.prepare("UPDATE ingest_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return row ?? null;
}

// --- Rattachement à une compétition et à une manche ----------------------------------------------

/** Mots d'un nom, sans accents ni casse ; les mots de moins de 3 lettres (« de », « la ») sont ignorés, pas les nombres. */
export function nameWords(s: string): Set<string> {
  const words = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 || /^\d+$/.test(w));
  return new Set(words);
}

/** Part des mots du nom reçu qu'on retrouve dans le nom de la compétition (0 à 1). */
export function nameScore(event: string, competition: string): number {
  const a = nameWords(event);
  if (!a.size) return 0;
  const b = nameWords(competition);
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

/** Date AAAA-MM-JJ en tête d'une date ou d'un horodatage ISO, sinon null. */
export function isoDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1]! : null;
}

export interface Match {
  competition_id: number;
  task_id: number | null;
}

/**
 * Compétition et manche d'un élément. Sans date : nom très proche (les trois quarts des mots au moins)
 * et une seule compétition en tête. Avec date : compétitions dont les dates ou une manche couvrent ce
 * jour, la plus proche par le nom (au moins un mot en commun, sans ex æquo). La manche est celle de ce
 * jour, s'il n'y en a qu'une.
 */
export function matchEvent(db: Db, event: string | null, day: string | null): Match | null {
  if (!event) return null;
  const comps = day
    ? queryAll<{ id: number; name: string }>(
        db,
        `SELECT id, name FROM competitions c
          WHERE (c.start_date IS NOT NULL AND c.start_date <= ? AND COALESCE(c.end_date, c.start_date) >= ?)
             OR EXISTS (SELECT 1 FROM tasks tk WHERE tk.competition_id = c.id AND tk.date = ?)`,
        day,
        day,
        day,
      )
    : queryAll<{ id: number; name: string }>(db, "SELECT id, name FROM competitions");
  const min = day ? Number.EPSILON : 0.75;
  const scored = comps.map((c) => ({ c, s: nameScore(event, c.name) })).filter((x) => x.s >= min).sort((a, b) => b.s - a.s);
  if (!scored.length || (scored[1] && scored[1].s === scored[0]!.s)) return null;
  const comp = scored[0]!.c;
  const tasks = day ? queryAll<{ id: number }>(db, "SELECT id FROM tasks WHERE competition_id = ? AND date = ?", comp.id, day) : [];
  return { competition_id: comp.id, task_id: tasks.length === 1 ? tasks[0]!.id : null };
}

// --- Éléments reçus -------------------------------------------------------------------------------

export interface ReportRow {
  id: number;
  /** Type annoncé par le service (« satisfaction », « incident »…), ou null. */
  type: string | null;
  /** Identifiant de l'élément chez le service, ou null. */
  external_id: string | null;
  /** Nom de l'événement et jour, lus dans l'élément. */
  event_name: string | null;
  event_date: string | null;
  competition_id: number | null;
  task_id: number | null;
  /** Rattachement : automatique, à la main par un administrateur, ou aucun. */
  matched: "auto" | "manual" | null;
  /** L'élément tel que reçu (JSON). */
  payload: string;
  key_id: number | null;
  received_at: number;
  updated_at: number;
}

export class IngestError extends Error {}

/** Premier champ présent parmi plusieurs noms possibles. */
const pick = (o: Record<string, unknown>, keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== "");

/** Texte court lu dans l'élément : chaîne ou nombre, sinon rien. */
function label(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") throw new IngestError(t("« {what} » doit être un texte ou un nombre.", { what }));
  const s = String(v).trim();
  if (s.length > MAX_LABEL) throw new IngestError(t("« {what} » trop long ({n} caractères au plus).", { what, n: MAX_LABEL }));
  return s || null;
}

export interface IngestItem {
  type: string | null;
  externalId: string | null;
  event: string | null;
  day: string | null;
  payload: Record<string, unknown>;
}

/** Champs reconnus pour le nom de l'événement et pour sa date. */
const EVENT_KEYS = ["event", "event_name", "competition", "competition_name"];
const DATE_KEYS = ["date", "day", "time", "datetime", "timestamp"];

/**
 * Éléments d'un envoi : un objet, une liste d'objets, ou un objet { "items": [...] }. Chaque élément
 * peut porter « type », « id », le nom de l'événement (« event ») et sa date (« date ») ; tout le reste
 * est gardé sans être lu.
 */
export function readItems(body: unknown): IngestItem[] {
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [body];
  if (!list.length) throw new IngestError(t("Aucun élément dans l'envoi."));
  if (list.length > MAX_INGEST_ITEMS) throw new IngestError(t("{n} éléments au plus par envoi.", { n: MAX_INGEST_ITEMS }));
  return list.map((x, i) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new IngestError(t("Élément {i} : objet JSON attendu.", { i: i + 1 }));
    const o = x as Record<string, unknown>;
    return { type: label(o.type, "type"), externalId: label(o.id, "id"), event: label(pick(o, EVENT_KEYS), "event"), day: isoDay(pick(o, DATE_KEYS)), payload: o };
  });
}

export interface SavedItem {
  id: number;
  type: string | null;
  external_id: string | null;
  status: "created" | "updated";
  competition_id: number | null;
  task_id: number | null;
}

/** Enregistre et rattache les éléments reçus ; un type et un identifiant déjà reçus sont remplacés. */
export function saveReports(db: Db, keyId: number | null, items: IngestItem[]): SavedItem[] {
  const now = Date.now();
  const find = db.prepare("SELECT id, matched, competition_id, task_id FROM task_reports WHERE type IS ? AND external_id = ?");
  const update = db.prepare("UPDATE task_reports SET payload = ?, event_name = ?, event_date = ?, competition_id = ?, task_id = ?, matched = ?, key_id = ?, updated_at = ? WHERE id = ?");
  const insert = db.prepare(
    "INSERT INTO task_reports (type, external_id, event_name, event_date, competition_id, task_id, matched, payload, key_id, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const out: SavedItem[] = [];
  db.exec("BEGIN");
  try {
    for (const it of items) {
      const payload = JSON.stringify(it.payload);
      const old = it.externalId === null ? undefined : (find.get(it.type, it.externalId) as { id: number; matched: string | null; competition_id: number | null; task_id: number | null } | undefined);
      // Un rattachement fait à la main est gardé quand l'élément revient.
      const m = old?.matched === "manual" ? { competition_id: old.competition_id!, task_id: old.task_id } : matchEvent(db, it.event, it.day);
      const matched = old?.matched === "manual" ? "manual" : m ? "auto" : null;
      const base = { type: it.type, external_id: it.externalId, competition_id: m?.competition_id ?? null, task_id: m?.task_id ?? null };
      if (old) {
        update.run(payload, it.event, it.day, base.competition_id, base.task_id, matched, keyId, now, old.id);
        out.push({ id: old.id, ...base, status: "updated" });
      } else {
        const r = insert.run(it.type, it.externalId, it.event, it.day, base.competition_id, base.task_id, matched, payload, keyId, now, now);
        out.push({ id: Number(r.lastInsertRowid), ...base, status: "created" });
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return out;
}

/**
 * Nouvel essai de rattachement des éléments rattachés automatiquement sans manche, ou pas du tout :
 * après la création d'une manche ou d'une compétition. Rend le nombre d'éléments rattachés à une manche.
 */
export function rematchPending(db: Db): number {
  const rows = queryAll<{ id: number; event_name: string | null; event_date: string | null }>(
    db,
    "SELECT id, event_name, event_date FROM task_reports WHERE task_id IS NULL AND matched IS NOT 'manual' AND event_name IS NOT NULL",
  );
  const set = db.prepare("UPDATE task_reports SET competition_id = ?, task_id = ?, matched = 'auto' WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    const m = matchEvent(db, r.event_name, r.event_date);
    if (!m) continue;
    set.run(m.competition_id, m.task_id, r.id);
    if (m.task_id) n++;
  }
  return n;
}

/** Rattachement à la main (administrateur) : compétition, et manche par son numéro si elle est donnée. */
export function assignReport(db: Db, id: number, competitionId: number | null, taskNumber: number | null): void {
  if (competitionId === null) {
    db.prepare("UPDATE task_reports SET competition_id = NULL, task_id = NULL, matched = NULL WHERE id = ?").run(id);
    return;
  }
  if (!queryOne(db, "SELECT id FROM competitions WHERE id = ?", competitionId)) throw new IngestError(t("Compétition introuvable."));
  let taskId: number | null = null;
  if (taskNumber !== null) {
    const tk = queryOne<{ id: number }>(db, "SELECT id FROM tasks WHERE competition_id = ? AND number = ? ORDER BY id LIMIT 1", competitionId, taskNumber);
    if (!tk) throw new IngestError(t("Manche {n} introuvable dans cette compétition.", { n: taskNumber }));
    taskId = tk.id;
  }
  db.prepare("UPDATE task_reports SET competition_id = ?, task_id = ?, matched = 'manual' WHERE id = ?").run(competitionId, taskId, id);
}

export function listReports(db: Db, taskId: number): ReportRow[] {
  return queryAll<ReportRow>(db, "SELECT * FROM task_reports WHERE task_id = ? ORDER BY updated_at DESC, id DESC", taskId);
}

/** Éléments sans manche (sans compétition, ou compétition trouvée mais pas la manche), plus récents d'abord. */
export function pendingReports(db: Db, limit = 200): Array<ReportRow & { competition_name: string | null }> {
  return queryAll<ReportRow & { competition_name: string | null }>(
    db,
    `SELECT r.*, c.name AS competition_name FROM task_reports r LEFT JOIN competitions c ON c.id = r.competition_id
      WHERE r.task_id IS NULL ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`,
    limit,
  );
}

export function deleteReport(db: Db, id: number, taskId?: number): void {
  if (taskId === undefined) db.prepare("DELETE FROM task_reports WHERE id = ?").run(id);
  else db.prepare("DELETE FROM task_reports WHERE id = ? AND task_id = ?").run(id, taskId);
}

// --- Appels bruts ---------------------------------------------------------------------------------

export interface IngestRequestRow {
  id: number;
  key_id: number | null;
  key_name?: string | null;
  received_at: number;
  path: string;
  content_type: string | null;
  size: number;
  body: string;
  /** Code HTTP rendu, et ce qu'on a fait du corps. */
  status: number | null;
  outcome: string | null;
}

/** Garde un appel tel que reçu ; seuls les {KEPT_REQUESTS} derniers restent. */
export function logRequest(db: Db, keyId: number, path: string, contentType: string | null, body: string): number {
  const r = db
    .prepare("INSERT INTO ingest_requests (key_id, received_at, path, content_type, size, body) VALUES (?, ?, ?, ?, ?, ?)")
    .run(keyId, Date.now(), path, contentType, Buffer.byteLength(body), body);
  const id = Number(r.lastInsertRowid);
  db.prepare("DELETE FROM ingest_requests WHERE id <= ?").run(id - KEPT_REQUESTS);
  return id;
}

export function setRequestOutcome(db: Db, id: number, status: number, outcome: string): void {
  db.prepare("UPDATE ingest_requests SET status = ?, outcome = ? WHERE id = ?").run(status, outcome, id);
}

/** Derniers appels, sans leur corps. */
export function listRequests(db: Db, limit = 50): Array<Omit<IngestRequestRow, "body">> {
  return queryAll<Omit<IngestRequestRow, "body">>(
    db,
    `SELECT r.id, r.key_id, k.name AS key_name, r.received_at, r.path, r.content_type, r.size, r.status, r.outcome
       FROM ingest_requests r LEFT JOIN ingest_keys k ON k.id = r.key_id ORDER BY r.id DESC LIMIT ?`,
    limit,
  );
}

export function getRequest(db: Db, id: number): IngestRequestRow | undefined {
  return queryOne<IngestRequestRow>(db, "SELECT * FROM ingest_requests WHERE id = ?", id);
}
