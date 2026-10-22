import type { DecisionKind, PilotDecision } from "@pgscore/engine";
import type { Db, DecisionRow } from "./db.js";
import { FormError } from "./settings.js";
import { N_, t } from "./i18n.js";
import { queryAll } from "./repo.js";

/** Décisions proposées dans la page de la manche, avec l'unité de leur valeur s'il en faut une. */
export const DECISION_KINDS: Record<DecisionKind, { label: string; unit?: string }> = {
  bonus: { label: N_("Bonus"), unit: "points" },
  penalty: { label: N_("Pénalité"), unit: "points" },
  "penalty-percent": { label: N_("Pénalité en pourcentage"), unit: "%" },
  goal: { label: N_("Goal accordé") },
  launched: { label: N_("A décollé sans trace (distance minimale)") },
  dnf: { label: N_("Présent, n'a pas volé (DNF)") },
  abs: { label: N_("Absent (ABS)") },
};

export function listDecisions(db: Db, taskId: number): DecisionRow[] {
  return queryAll<DecisionRow>(db, `SELECT d.*, u.name AS created_by_name FROM task_decisions d LEFT JOIN users u ON u.id = d.created_by
       WHERE d.task_id = ? ORDER BY CAST(d.pilot_key AS INTEGER), d.pilot_key, d.id`, taskId);
}

/** Ajoute une décision lue depuis le formulaire. */
export function addDecision(db: Db, taskId: number, userId: number, form: Record<string, unknown>): void {
  const pilot = String(form.pilot ?? "").trim();
  const name = String(form.name ?? "").trim() || null;
  const kind = String(form.kind ?? "") as DecisionKind;
  const reason = String(form.reason ?? "").trim();
  if (!pilot) throw new FormError(t("Numéro du pilote obligatoire."));
  if (!(kind in DECISION_KINDS)) throw new FormError(t("Type de décision inconnu."));
  if (!reason) throw new FormError(t("Motif obligatoire : il apparaît dans les résultats."));
  let value: number | null = null;
  if (DECISION_KINDS[kind].unit) {
    value = Number(String(form.value ?? "").replace(",", "."));
    if (!(Number.isFinite(value) && value > 0)) throw new FormError(t("Valeur attendue : un nombre positif."));
    if (kind === "penalty-percent" && value > 100) throw new FormError(t("Pourcentage : 100 au plus."));
  }
  const now = Date.now();
  db.prepare(
    "INSERT INTO task_decisions (task_id, pilot_key, pilot_name, kind, value, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(taskId, pilot, name, kind, value, reason, userId, now);
  touchScoring(db, taskId);
}

export function deleteDecision(db: Db, taskId: number, id: number): void {
  db.prepare("DELETE FROM task_decisions WHERE id = ? AND task_id = ?").run(id, taskId);
  touchScoring(db, taskId);
}

/** Note qu'un élément des points a changé : le dernier classement est à relancer. */
export function touchScoring(db: Db, taskId: number): void {
  db.prepare("UPDATE tasks SET scoring_changed_at = ? WHERE id = ?").run(Date.now(), taskId);
}

export function engineDecisions(rows: DecisionRow[]): PilotDecision[] {
  return rows.map((d) => ({
    pilot: d.pilot_key,
    ...(d.pilot_name ? { name: d.pilot_name } : {}),
    kind: d.kind,
    ...(d.value !== null ? { value: d.value } : {}),
    reason: d.reason,
  }));
}

/**
 * Fichier IGC vide (aucun point B) : le plus souvent, le pilote n'a pas volé. Ce fichier n'est pas
 * gardé comme trace ; le pilote est marqué DNF d'office, décision que l'organisateur peut supprimer.
 */
export function isEmptyIgc(text: string): boolean {
  return !/^B\d{6}/m.test(text);
}

/** Motif des DNF posés d'office pour une trace vide. Il les distingue des DNF saisis à la main. */
export const EMPTY_TRACK_REASON = N_("Trace vide à l'envoi : présent, n'a pas volé.");

/**
 * DNF d'office pour un pilote dont le fichier est vide, sauf s'il a déjà une trace en vigueur ou une
 * décision sur sa présence (DNF, ABS, décollé sans trace). Rend vrai si la décision est ajoutée.
 */
export function addEmptyTrackDnf(db: Db, taskId: number, userId: number, pilotKey: string, pilotName: string | null): boolean {
  if (db.prepare("SELECT 1 FROM tracks WHERE task_id = ? AND pilot_key = ?").get(taskId, pilotKey)) return false;
  if (db.prepare("SELECT 1 FROM task_decisions WHERE task_id = ? AND pilot_key = ? AND kind IN ('dnf', 'abs', 'launched')").get(taskId, pilotKey)) return false;
  db.prepare(
    "INSERT INTO task_decisions (task_id, pilot_key, pilot_name, kind, value, reason, created_by, created_at) VALUES (?, ?, ?, 'dnf', NULL, ?, ?, ?)",
  ).run(taskId, pilotKey, pilotName, EMPTY_TRACK_REASON, userId, Date.now());
  touchScoring(db, taskId);
  return true;
}

/** Une vraie trace est arrivée pour ce pilote : le DNF posé d'office pour un fichier vide n'a plus lieu d'être. */
export function clearEmptyTrackDnf(db: Db, taskId: number, pilotKey: string): void {
  const r = db.prepare("DELETE FROM task_decisions WHERE task_id = ? AND pilot_key = ? AND kind = 'dnf' AND reason = ?").run(taskId, pilotKey, EMPTY_TRACK_REASON);
  if (r.changes) touchScoring(db, taskId);
}
