import type { Db, PilotRow, RankingRow } from "./db.js";
import { FormError } from "./settings.js";

/**
 * Classements extraits du général : mêmes scores de manche et même FTV, on garde les pilotes concernés
 * et on renumérote. Les pilotes concernés sont ceux qui vérifient toutes les conditions de la règle,
 * plus ceux ajoutés à la main, moins ceux retirés à la main.
 */

export const RULE_FIELDS = {
  gender: "Genre",
  nation: "Nation",
  glider_brand: "Marque voile",
  glider_model: "Modèle voile",
  glider_class: "Classe de voile",
  harness_brand: "Marque sellette",
  harness_model: "Modèle sellette",
  weight_max: "PTV max (kg)",
} as const satisfies Partial<Record<keyof PilotRow, string>>;
export type RuleField = keyof typeof RULE_FIELDS;

export const RULE_OPS = {
  in: "est l'un de",
  not_in: "n'est aucun de",
  contains: "contient",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
} as const;
export type RuleOp = keyof typeof RULE_OPS;
const NUMERIC_OPS: RuleOp[] = ["lt", "lte", "gt", "gte"];

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  /** Liste séparée par des virgules pour in / not_in, texte pour contains, nombre sinon. */
  value: string;
}
export interface RankingRule {
  conditions: RuleCondition[];
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .trim();
const list = (v: string) => v.split(/[,;]/).map(norm).filter(Boolean);

export function matches(rule: RankingRule, p: PilotRow): boolean {
  return rule.conditions.every((c) => {
    const raw = p[c.field];
    if (NUMERIC_OPS.includes(c.op)) {
      if (typeof raw !== "number") return false;
      const v = Number(c.value);
      return c.op === "lt" ? raw < v : c.op === "lte" ? raw <= v : c.op === "gt" ? raw > v : raw >= v;
    }
    const x = raw === null || raw === undefined ? "" : norm(String(raw));
    if (c.op === "contains") return x !== "" && x.includes(norm(c.value));
    const inList = x !== "" && list(c.value).includes(x);
    return c.op === "in" ? inList : !inList;
  });
}

export function describeRule(rule: RankingRule): string {
  if (!rule.conditions.length) return "pilotes choisis à la main";
  return rule.conditions.map((c) => `${RULE_FIELDS[c.field].toLowerCase()} ${RULE_OPS[c.op]} ${c.value}`).join(" et ");
}

/** Lit la règle du formulaire : champs field1/op1/value1, field2…; une condition sans valeur est ignorée. */
export function ruleFromForm(form: Record<string, unknown>): RankingRule {
  const conditions: RuleCondition[] = [];
  for (let i = 1; i <= 4; i++) {
    const field = String(form[`field${i}`] ?? "") as RuleField;
    const op = String(form[`op${i}`] ?? "") as RuleOp;
    const value = String(form[`value${i}`] ?? "").trim();
    if (!field || !value) continue;
    if (!(field in RULE_FIELDS)) throw new FormError("Critère inconnu.");
    if (!(op in RULE_OPS)) throw new FormError("Comparaison inconnue.");
    const numeric = field === "weight_max";
    if (numeric !== NUMERIC_OPS.includes(op))
      throw new FormError(numeric ? "PTV max : comparez avec <, ≤, > ou ≥." : `${RULE_FIELDS[field]} : comparez avec « est l'un de », « n'est aucun de » ou « contient ».`);
    if (numeric && !Number.isFinite(Number(value.replace(",", ".")))) throw new FormError("PTV max : un nombre de kg est attendu.");
    conditions.push({ field, op, value: numeric ? String(Number(value.replace(",", "."))) : value });
  }
  return { conditions };
}

export interface Ranking {
  row: RankingRow;
  rule: RankingRule;
  /** Ajouts et retraits à la main, par numéro. */
  overrides: Map<string, boolean>;
}

export function listRankings(db: Db, compId: number): Ranking[] {
  const rows = db.prepare("SELECT * FROM competition_rankings WHERE competition_id = ? ORDER BY id").all(compId) as unknown as RankingRow[];
  const ov = db.prepare("SELECT pilot_key, included FROM ranking_overrides WHERE ranking_id = ?");
  return rows.map((row) => ({
    row,
    rule: JSON.parse(row.rule) as RankingRule,
    overrides: new Map((ov.all(row.id) as Array<{ pilot_key: string; included: number }>).map((o) => [o.pilot_key, o.included === 1])),
  }));
}

export function getRanking(db: Db, compId: number, id: number): Ranking | null {
  return listRankings(db, compId).find((r) => r.row.id === id) ?? null;
}

/** Numéros des pilotes du classement. */
export function rankingMembers(r: Ranking, pilots: PilotRow[]): Set<string> {
  const out = new Set(r.rule.conditions.length ? pilots.filter((p) => matches(r.rule, p)).map((p) => p.pilot_key) : []);
  for (const [key, inc] of r.overrides) inc ? out.add(key) : out.delete(key);
  return out;
}

export function createRanking(db: Db, compId: number, form: Record<string, unknown>): number {
  const name = String(form.name ?? "").trim();
  if (!name) throw new FormError("Nom du classement obligatoire.");
  const rule = ruleFromForm(form);
  return Number(
    db.prepare("INSERT INTO competition_rankings (competition_id, name, rule, created_at) VALUES (?, ?, ?, ?)").run(compId, name, JSON.stringify(rule), Date.now())
      .lastInsertRowid,
  );
}

export function updateRanking(db: Db, r: Ranking, form: Record<string, unknown>): void {
  const name = String(form.name ?? "").trim();
  if (!name) throw new FormError("Nom du classement obligatoire.");
  db.prepare("UPDATE competition_rankings SET name = ?, rule = ? WHERE id = ?").run(name, JSON.stringify(ruleFromForm(form)), r.row.id);
}

export function deleteRanking(db: Db, r: Ranking): void {
  db.prepare("DELETE FROM competition_rankings WHERE id = ?").run(r.row.id);
}

/** Ajoute (included) ou retire un pilote à la main ; « reset » revient à la règle. */
export function setOverride(db: Db, r: Ranking, pilotKey: string, how: "include" | "exclude" | "reset"): void {
  const key = pilotKey.trim();
  if (!key) throw new FormError("Numéro du pilote obligatoire.");
  if (how === "reset") db.prepare("DELETE FROM ranking_overrides WHERE ranking_id = ? AND pilot_key = ?").run(r.row.id, key);
  else
    db.prepare("INSERT INTO ranking_overrides (ranking_id, pilot_key, included) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET included = excluded.included").run(
      r.row.id,
      key,
      how === "include" ? 1 : 0,
    );
}

/** Classement créé avec chaque compétition : seul le féminin, les autres sont à créer au besoin. */
export function addDefaultRankings(db: Db, compId: number): void {
  const rule: RankingRule = { conditions: [{ field: "gender", op: "in", value: "F" }] };
  db.prepare("INSERT INTO competition_rankings (competition_id, name, rule, created_at) VALUES (?, 'Féminin', ?, ?)").run(compId, JSON.stringify(rule), Date.now());
}
