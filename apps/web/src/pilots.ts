import type { Db, PilotRow } from "./db.js";
import { FormError } from "./settings.js";
import { N_, t } from "./i18n.js";

/** Champs d'un pilote inscrit, sans l'identifiant en base. */
export type PilotFields = Omit<PilotRow, "id" | "competition_id">;

/** Colonnes du tableau, de l'export CSV et de l'import CSV (avec les en-têtes reconnus). */
export const PILOT_COLUMNS: Array<{ key: keyof PilotFields; label: string; csv: string; aliases: string[] }> = [
  { key: "pilot_key", label: N_("N°"), csv: "numero", aliases: ["n", "no", "num", "number", "id", "pilot", "pilote", "dossard", "bib"] },
  { key: "name", label: N_("Nom"), csv: "nom", aliases: ["name", "pilot name", "nom prenom", "full name"] },
  { key: "gender", label: N_("Genre"), csv: "genre", aliases: ["gender", "sex", "sexe", "female"] },
  { key: "nation", label: N_("Nation"), csv: "nation", aliases: ["nat", "country", "pays", "nationality", "nationalite"] },
  { key: "civl_id", label: N_("CIVL ID"), csv: "civl_id", aliases: ["civl", "civlid", "fai id"] },
  { key: "glider_brand", label: N_("Marque voile"), csv: "voile_marque", aliases: ["glider brand", "glider make", "marque voile", "marque"] },
  { key: "glider_model", label: N_("Modèle voile"), csv: "voile_modele", aliases: ["glider", "glider model", "modele voile", "voile", "aile"] },
  { key: "glider_class", label: N_("Classe"), csv: "voile_classe", aliases: ["class", "classe", "en", "certification", "homologation", "glider class"] },
  { key: "harness_brand", label: N_("Marque sellette"), csv: "sellette_marque", aliases: ["harness brand", "harness make", "marque sellette"] },
  { key: "harness_model", label: N_("Modèle sellette"), csv: "sellette_modele", aliases: ["harness", "harness model", "modele sellette", "sellette"] },
  { key: "weight_max", label: N_("PTV max (kg)"), csv: "ptv_max_kg", aliases: ["ptv", "ptv max", "weight", "max weight", "poids", "poids max", "total weight"] },
  { key: "sponsor", label: N_("Sponsor"), csv: "sponsor", aliases: ["sponsors", "team", "equipe", "club"] },
];

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\-./()°]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function parseGender(v: string): "F" | "M" | null {
  const x = norm(v);
  if (!x) return null;
  if (["f", "female", "femme", "w", "woman", "women", "feminin", "1", "true", "oui", "yes"].includes(x)) return "F";
  if (["m", "male", "homme", "h", "man", "men", "masculin", "0", "false", "non", "no"].includes(x)) return "M";
  throw new FormError(t("Genre non reconnu : « {value} » (F ou M attendu).", { value: v }));
}

/** Nettoie et valide un pilote ; les champs vides deviennent null. */
export function cleanPilot(raw: Partial<Record<keyof PilotFields, unknown>>): PilotFields {
  const str = (k: keyof PilotFields) => {
    const v = String(raw[k] ?? "").trim();
    return v ? v : null;
  };
  const key = str("pilot_key");
  if (!key) throw new FormError(t("Numéro du pilote obligatoire."));
  const name = str("name");
  if (!name) throw new FormError(t("Pilote {key} : nom obligatoire.", { key }));
  const w = str("weight_max");
  const weight = w === null ? null : Number(w.replace(",", ".").replace(/\s*kg$/i, ""));
  if (weight !== null && !(Number.isFinite(weight) && weight > 0 && weight < 1000)) throw new FormError(t("Pilote {key} : PTV max illisible (« {value} »).", { key, value: w ?? "" }));
  const nation = str("nation");
  return {
    pilot_key: key,
    name,
    gender: raw.gender === null || raw.gender === undefined ? null : parseGender(String(raw.gender)),
    nation: nation ? nation.toUpperCase() : null,
    civl_id: str("civl_id"),
    glider_brand: str("glider_brand"),
    glider_model: str("glider_model"),
    glider_class: str("glider_class")?.toUpperCase().replace(/^EN\s*-?\s*/, "EN-").replace(/^EN-$/, "EN") ?? null,
    harness_brand: str("harness_brand"),
    harness_model: str("harness_model"),
    weight_max: weight,
    sponsor: str("sponsor"),
  };
}

/** Sépare « Ozone Enzo 3 » en marque et modèle (premier mot = marque). */
export function splitBrand(v: string): { brand: string | null; model: string | null } {
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return { brand: null, model: null };
  const i = t.indexOf(" ");
  return i < 0 ? { brand: t, model: null } : { brand: t.slice(0, i), model: t.slice(i + 1) };
}

// --- Import ---------------------------------------------------------------------------------

/** Lit un CSV (séparateur , ; ou tabulation, guillemets doubles). */
export function parseCsvRows(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const first = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", "\t", ","].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

export function pilotsFromCsv(text: string): PilotFields[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new FormError(t("CSV vide : une ligne d'en-tête puis une ligne par pilote."));
  const head = rows[0]!.map(norm);
  const index = new Map<keyof PilotFields, number>();
  for (const c of PILOT_COLUMNS) {
    const names = [norm(c.csv), norm(c.label), ...c.aliases.map(norm)];
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0 && !index.has(c.key)) index.set(c.key, i);
  }
  if (!index.has("pilot_key") || !index.has("name"))
    throw new FormError(t("Colonnes « numero » et « nom » obligatoires. En-têtes lus : {headers}.", { headers: rows[0]!.join(", ") }));
  return rows.slice(1).map((r, n) => {
    const raw: Partial<Record<keyof PilotFields, unknown>> = {};
    for (const [k, i] of index) raw[k] = r[i] ?? "";
    // Une seule colonne « voile » ou « sellette » : marque et modèle ensemble.
    for (const [b, m] of [["glider_brand", "glider_model"], ["harness_brand", "harness_model"]] as const)
      if (!index.has(b) && raw[m]) {
        const x = splitBrand(String(raw[m]));
        raw[b] = x.brand;
        raw[m] = x.model;
      }
    try {
      return cleanPilot(raw);
    } catch (e) {
      throw new FormError(t("Ligne {n} : {error}", { n: n + 2, error: (e as Error).message }));
    }
  });
}

const xmlAttrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!.toLowerCase()] = decodeXml(m[3] ?? m[4] ?? "");
  return out;
};
const decodeXml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * Pilotes d'un fichier FSDB (base du logiciel FS de la CIVL) : éléments <FsParticipant>, avec id, name,
 * female, nat_code_3166_a3, glider, CIVLID et éventuellement des <FsCustomAttribute name value>.
 */
export function pilotsFromFsdb(text: string): PilotFields[] {
  const parts = [...text.matchAll(/<FsParticipant\b([^>]*?)(\/>|>([\s\S]*?)<\/FsParticipant>)/g)];
  if (!parts.length) throw new FormError(t("Aucun pilote (<FsParticipant>) dans ce fichier FSDB."));
  return parts.map((m, n) => {
    const a = xmlAttrs(m[1]!);
    const custom: Record<string, string> = {};
    for (const c of (m[3] ?? "").matchAll(/<FsCustomAttribute\b([^>]*)\/?>/g)) {
      const x = xmlAttrs(c[1]!);
      if (x.name) custom[norm(x.name)] = x.value ?? "";
    }
    const pick = (...keys: string[]) => keys.map((k) => a[k] ?? custom[norm(k)]).find((v) => v !== undefined && v !== "") ?? "";
    const glider = splitBrand(pick("glider"));
    const harness = splitBrand(pick("harness", "sellette"));
    const female = pick("female");
    try {
      return cleanPilot({
        pilot_key: pick("id"),
        name: pick("name"),
        gender: female === "" ? null : female === "1" || female.toLowerCase() === "true" ? "F" : "M",
        nation: pick("nat_code_3166_a3", "nation", "nat"),
        civl_id: pick("civlid", "civl_id", "fai_id"),
        glider_brand: pick("glider_brand") || glider.brand,
        glider_model: pick("glider_model") || glider.model,
        glider_class: pick("glider_class", "class", "certification", "en"),
        harness_brand: pick("harness_brand") || harness.brand,
        harness_model: pick("harness_model") || harness.model,
        weight_max: pick("ptv", "ptv max", "max weight", "weight"),
        sponsor: pick("sponsor", "team"),
      });
    } catch (e) {
      throw new FormError(t("Pilote n° {n} du FSDB : {error}", { n: n + 1, error: (e as Error).message }));
    }
  });
}

/** Lit un fichier d'inscriptions : FSDB (XML) ou CSV. */
export function pilotsFromFile(name: string, text: string): PilotFields[] {
  const isXml = /\.fsdb$/i.test(name) || /^\s*(<\?xml|<Fs)/.test(text);
  const list = isXml ? pilotsFromFsdb(text) : pilotsFromCsv(text);
  const seen = new Set<string>();
  for (const p of list) {
    if (seen.has(p.pilot_key)) throw new FormError(t("Numéro {key} en double dans le fichier.", { key: p.pilot_key }));
    seen.add(p.pilot_key);
  }
  return list;
}

// --- Base -----------------------------------------------------------------------------------

export function listPilots(db: Db, compId: number): PilotRow[] {
  return db
    .prepare("SELECT * FROM competition_pilots WHERE competition_id = ? ORDER BY CAST(pilot_key AS INTEGER), pilot_key")
    .all(compId) as unknown as PilotRow[];
}

const FIELDS = PILOT_COLUMNS.map((c) => c.key);

/** Ajoute ou remplace des pilotes (par numéro). Renvoie le nombre d'ajouts et de mises à jour. */
export function upsertPilots(db: Db, compId: number, list: PilotFields[]): { added: number; updated: number } {
  const exists = db.prepare("SELECT 1 FROM competition_pilots WHERE competition_id = ? AND pilot_key = ?");
  const up = db.prepare(
    `INSERT INTO competition_pilots (competition_id, ${FIELDS.join(", ")}) VALUES (?, ${FIELDS.map(() => "?").join(", ")})
     ON CONFLICT (competition_id, pilot_key) DO UPDATE SET ${FIELDS.filter((f) => f !== "pilot_key").map((f) => `${f} = excluded.${f}`).join(", ")}`,
  );
  let added = 0;
  let updated = 0;
  db.exec("BEGIN");
  try {
    for (const p of list) {
      if (exists.get(compId, p.pilot_key)) updated++;
      else added++;
      up.run(compId, ...FIELDS.map((f) => p[f]));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { added, updated };
}

/**
 * Enregistre le tableau modifié dans la page : champs « p.<id>.<champ> », case « del.<id> » pour retirer
 * un pilote, et ligne « new.<champ> » pour en ajouter un.
 */
export function savePilotTable(db: Db, compId: number, form: Record<string, unknown>): { saved: number; removed: number; added: number } {
  const byId = new Map<number, Partial<Record<keyof PilotFields, unknown>>>();
  const fresh: Partial<Record<keyof PilotFields, unknown>> = {};
  const removed = new Set<number>();
  for (const [k, v] of Object.entries(form)) {
    const del = /^del\.(\d+)$/.exec(k);
    if (del) removed.add(Number(del[1]));
    const m = /^(?:p\.(\d+)|new)\.(\w+)$/.exec(k);
    if (!m || !FIELDS.includes(m[2] as keyof PilotFields)) continue;
    const value = v === "" && m[2] === "gender" ? null : v;
    if (m[1] === undefined) fresh[m[2] as keyof PilotFields] = value;
    else byId.set(Number(m[1]), { ...(byId.get(Number(m[1])) ?? {}), [m[2]!]: value });
  }
  const current = listPilots(db, compId);
  const own = new Set(current.map((r) => r.id));
  const kept = [...byId].filter(([id]) => own.has(id) && !removed.has(id)).map(([id, raw]) => ({ id, p: cleanPilot(raw) }));
  const hasNew = Object.values(fresh).some((v) => v !== null && String(v).trim() !== "");
  const added = hasNew ? cleanPilot(fresh) : null;
  // Numéros après enregistrement : ceux du formulaire, et ceux des pilotes absents du formulaire.
  const seen = new Map<string, number>();
  for (const r of current) if (!byId.has(r.id) && !removed.has(r.id)) seen.set(r.pilot_key, r.id);
  for (const { id, p } of kept) {
    if (seen.has(p.pilot_key)) throw new FormError(t("Numéro {key} en double.", { key: p.pilot_key }));
    seen.set(p.pilot_key, id);
  }
  if (added && seen.has(added.pilot_key)) throw new FormError(t("Numéro {key} déjà inscrit.", { key: added.pilot_key }));
  const set = db.prepare(`UPDATE competition_pilots SET ${FIELDS.map((f) => `${f} = ?`).join(", ")} WHERE id = ? AND competition_id = ?`);
  const drop = db.prepare("DELETE FROM competition_pilots WHERE id = ? AND competition_id = ?");
  db.exec("BEGIN");
  try {
    for (const id of removed) drop.run(id, compId);
    // Numéros échangés entre deux pilotes : on libère d'abord les numéros, puis on écrit.
    const tmp = db.prepare("UPDATE competition_pilots SET pilot_key = '~' || id WHERE id = ? AND competition_id = ?");
    for (const { id } of kept) tmp.run(id, compId);
    for (const { id, p } of kept) set.run(...FIELDS.map((f) => p[f]), id, compId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if (added) upsertPilots(db, compId, [added]);
  return { saved: kept.length, removed: [...removed].filter((id) => own.has(id)).length, added: added ? 1 : 0 };
}

export function pilotsCsv(rows: PilotRow[]): string {
  const q = (v: unknown) => {
    const x = v === null || v === undefined ? "" : String(v);
    return /[",\n;]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  return [PILOT_COLUMNS.map((c) => c.csv), ...rows.map((r) => PILOT_COLUMNS.map((c) => r[c.key]))].map((r) => r.map(q).join(",")).join("\n") + "\n";
}
