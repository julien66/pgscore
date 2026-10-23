import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { t } from "./i18n.js";
import { queryAll, queryOne } from "./repo.js";

/**
 * Données reçues d'un service externe (bot Telegram de la compétition) sur les manches : satisfaction
 * des pilotes, accidents et incidents… Le service s'authentifie avec une clé d'envoi propre à une
 * compétition (« pgsi_… »), qui ne sert qu'à cet envoi. Chaque élément reçu est gardé tel quel, en
 * JSON, avec son type et son identifiant chez le service : renvoyer un même identifiant remplace
 * l'élément. Le traitement (moyenne de satisfaction, liste des incidents) viendra sur ces données.
 */

/** Taille d'un envoi. */
export const MAX_INGEST = 1024 * 1024;
/** Éléments par envoi. */
export const MAX_INGEST_ITEMS = 1000;
const MAX_LABEL = 64;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// --- Clés d'envoi, une ou plusieurs par compétition ----------------------------------------------

export interface IngestKeyRow {
  id: number;
  competition_id: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

/** Crée une clé d'envoi. Elle n'est montrée qu'une fois : seule son empreinte est gardée. */
export function createIngestKey(db: Db, competitionId: number, userId: number, name: string): string {
  const token = `pgsi_${randomBytes(30).toString("base64url")}`;
  db.prepare("INSERT INTO ingest_keys (competition_id, name, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(
    competitionId,
    name,
    hash(token),
    userId,
    Date.now(),
  );
  return token;
}

export function listIngestKeys(db: Db, competitionId: number): IngestKeyRow[] {
  return queryAll<IngestKeyRow>(db, "SELECT id, competition_id, name, created_at, last_used_at FROM ingest_keys WHERE competition_id = ? ORDER BY id DESC", competitionId);
}

export function deleteIngestKey(db: Db, competitionId: number, id: number): void {
  db.prepare("DELETE FROM ingest_keys WHERE id = ? AND competition_id = ?").run(id, competitionId);
}

/** Clé d'envoi reconnue : sa compétition. */
export function ingestKey(db: Db, token: string): { id: number; competition_id: number } | null {
  if (!token.startsWith("pgsi_")) return null;
  const h = hash(token);
  const row = queryOne<{ id: number; competition_id: number }>(db, "SELECT id, competition_id FROM ingest_keys WHERE token_hash = ?", h);
  if (row) db.prepare("UPDATE ingest_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return row ?? null;
}

// --- Éléments reçus -------------------------------------------------------------------------------

export interface ReportRow {
  id: number;
  task_id: number;
  /** Type annoncé par le service (« satisfaction », « incident »…), ou null. */
  type: string | null;
  /** Identifiant de l'élément chez le service, ou null. */
  external_id: string | null;
  /** L'élément tel que reçu (JSON). */
  payload: string;
  key_id: number | null;
  received_at: number;
  updated_at: number;
}

export class IngestError extends Error {}

/** Texte court lu dans l'élément (type, identifiant) : chaîne ou nombre, sinon rien. */
function label(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") throw new IngestError(t("« {what} » doit être un texte ou un nombre.", { what }));
  const s = String(v).trim();
  if (s.length > MAX_LABEL) throw new IngestError(t("« {what} » trop long ({n} caractères au plus).", { what, n: MAX_LABEL }));
  return s || null;
}

/**
 * Éléments d'un envoi : un objet, une liste d'objets, ou un objet { "items": [...] }. Chaque élément
 * peut porter « type » et « id » ; tout le reste est gardé sans être lu.
 */
export function readItems(body: unknown): Array<{ type: string | null; externalId: string | null; payload: Record<string, unknown> }> {
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [body];
  if (!list.length) throw new IngestError(t("Aucun élément dans l'envoi."));
  if (list.length > MAX_INGEST_ITEMS) throw new IngestError(t("{n} éléments au plus par envoi.", { n: MAX_INGEST_ITEMS }));
  return list.map((x, i) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new IngestError(t("Élément {i} : objet JSON attendu.", { i: i + 1 }));
    const o = x as Record<string, unknown>;
    return { type: label(o.type, "type"), externalId: label(o.id, "id"), payload: o };
  });
}

/** Enregistre les éléments reçus pour une manche ; un identifiant déjà reçu (même type) est remplacé. */
export function saveReports(db: Db, taskId: number, keyId: number | null, items: ReturnType<typeof readItems>): Array<{ id: number; type: string | null; external_id: string | null; status: "created" | "updated" }> {
  const now = Date.now();
  const find = db.prepare("SELECT id FROM task_reports WHERE task_id = ? AND type IS ? AND external_id = ?");
  const update = db.prepare("UPDATE task_reports SET payload = ?, key_id = ?, updated_at = ? WHERE id = ?");
  const insert = db.prepare("INSERT INTO task_reports (task_id, type, external_id, payload, key_id, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const out: ReturnType<typeof saveReports> = [];
  db.exec("BEGIN");
  try {
    for (const it of items) {
      const payload = JSON.stringify(it.payload);
      const old = it.externalId === null ? undefined : (find.get(taskId, it.type, it.externalId) as { id: number } | undefined);
      if (old) {
        update.run(payload, keyId, now, old.id);
        out.push({ id: old.id, type: it.type, external_id: it.externalId, status: "updated" });
      } else {
        const r = insert.run(taskId, it.type, it.externalId, payload, keyId, now, now);
        out.push({ id: Number(r.lastInsertRowid), type: it.type, external_id: it.externalId, status: "created" });
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return out;
}

export function listReports(db: Db, taskId: number): ReportRow[] {
  return queryAll<ReportRow>(db, "SELECT * FROM task_reports WHERE task_id = ? ORDER BY updated_at DESC, id DESC", taskId);
}

export function deleteReport(db: Db, taskId: number, id: number): void {
  db.prepare("DELETE FROM task_reports WHERE id = ? AND task_id = ?").run(id, taskId);
}
