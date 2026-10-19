import type { DecisionKind, PilotDecision } from "@pgscore/engine";
import type { Db, DecisionRow } from "./db.js";
import { FormError } from "./settings.js";

/** Décisions proposées dans la page de la manche, avec l'unité de leur valeur s'il en faut une. */
export const DECISION_KINDS: Record<DecisionKind, { label: string; unit?: string }> = {
  bonus: { label: "Bonus", unit: "points" },
  penalty: { label: "Pénalité", unit: "points" },
  "penalty-percent": { label: "Pénalité en pourcentage", unit: "%" },
  goal: { label: "Goal accordé" },
  launched: { label: "A décollé sans trace (distance minimale)" },
  dnf: { label: "Présent, n'a pas volé (DNF)" },
  abs: { label: "Absent (ABS)" },
};

export function listDecisions(db: Db, taskId: number): DecisionRow[] {
  return db
    .prepare(
      `SELECT d.*, u.name AS created_by_name FROM task_decisions d LEFT JOIN users u ON u.id = d.created_by
       WHERE d.task_id = ? ORDER BY CAST(d.pilot_key AS INTEGER), d.pilot_key, d.id`,
    )
    .all(taskId) as unknown as DecisionRow[];
}

/** Ajoute une décision lue depuis le formulaire. */
export function addDecision(db: Db, taskId: number, userId: number, form: Record<string, unknown>): void {
  const pilot = String(form.pilot ?? "").trim();
  const name = String(form.name ?? "").trim() || null;
  const kind = String(form.kind ?? "") as DecisionKind;
  const reason = String(form.reason ?? "").trim();
  if (!pilot) throw new FormError("Numéro du pilote obligatoire.");
  if (!(kind in DECISION_KINDS)) throw new FormError("Type de décision inconnu.");
  if (!reason) throw new FormError("Motif obligatoire : il apparaît dans les résultats.");
  let value: number | null = null;
  if (DECISION_KINDS[kind].unit) {
    value = Number(String(form.value ?? "").replace(",", "."));
    if (!(Number.isFinite(value) && value > 0)) throw new FormError("Valeur attendue : un nombre positif.");
    if (kind === "penalty-percent" && value > 100) throw new FormError("Pourcentage : 100 au plus.");
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
