import { child, children, parseXml, type XmlEl } from "./xml.js";
import type { Db, PilotRow } from "./db.js";
import { FormError } from "./settings.js";
import { nameKey } from "./files.js";
import { N_, t } from "./i18n.js";
import { queryAll } from "./repo.js";
import { parseCsvRows, toCsv } from "./text.js";

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

/**
 * Inscrit d'office les pilotes des traces qui ne sont pas encore dans la liste : numéro et nom de leur
 * trace. Une trace sans nom de pilote (seulement l'instrument) n'est pas inscrite. Un nom déjà inscrit
 * n'est pas ajouté une seconde fois ; s'il l'était sous un nom de trace (« rene-test ») et arrive avec un
 * numéro, l'inscrit prend ce numéro et ses traces le suivent. Sans transaction propre. Rend le nombre d'inscrits ajoutés.
 */
export function registerTrackPilots(db: Db, compId: number): number {
  const byName = new Map(
    (db.prepare("SELECT pilot_key, name FROM competition_pilots WHERE competition_id = ?").all(compId) as Array<{ pilot_key: string; name: string }>).map((r) => [nameKey(r.name), r.pilot_key]),
  );
  const ins = db.prepare("INSERT OR IGNORE INTO competition_pilots (competition_id, pilot_key, name) VALUES (?, ?, ?)");
  const numeric = (k: string) => /^\d+$/.test(k);
  let n = 0;
  for (const p of trackPilots(db, compId)) {
    if (p.name === p.pilot_key) continue;
    const k = nameKey(p.name);
    if (!k) continue;
    const other = byName.get(k);
    if (other !== undefined) {
      if (!numeric(other) && numeric(p.pilot_key)) {
        db.prepare("UPDATE competition_pilots SET pilot_key = ? WHERE competition_id = ? AND pilot_key = ?").run(p.pilot_key, compId, other);
        db.prepare("UPDATE OR IGNORE tracks SET pilot_key = ? WHERE pilot_key = ? AND task_id IN (SELECT id FROM tasks WHERE competition_id = ?)").run(p.pilot_key, other, compId);
        byName.set(k, p.pilot_key);
      }
      continue;
    }
    byName.set(k, p.pilot_key);
    n += Number(ins.run(compId, p.pilot_key, p.name).changes);
  }
  return n;
}

// --- Import ---------------------------------------------------------------------------------

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

/**
 * Pilotes d'un fichier FSDB (base du logiciel FS de la CIVL) : éléments <FsParticipant> de la compétition
 * (pas ceux des manches ni des résultats), avec id, name, female, nat_code_3166_a3, glider, sponsor, CIVLID,
 * et les <FsCustomAttribute> des inscriptions civlcomps (Wing Manufacturer, Wing Model, PG Certification,
 * Harness Manufacturer, Harness Model…).
 */
export function pilotsFromFsdb(text: string): PilotFields[] {
  let doc;
  try {
    doc = parseXml(text);
  } catch (e) {
    throw new FormError(t("FSDB illisible : {error}", { error: (e as Error).message }));
  }
  const comp = child(child(doc, "Fs"), "FsCompetition");
  const parts = children(child(comp, "FsParticipants"), "FsParticipant");
  if (!parts.length) throw new FormError(t("Aucun pilote (<FsParticipant>) dans ce fichier FSDB."));
  return parts.map((p, n) => {
    try {
      return fsdbPilot(p);
    } catch (e) {
      throw new FormError(t("Pilote n° {n} du FSDB : {error}", { n: n + 1, error: (e as Error).message }));
    }
  });
}

/** Attributs personnalisés d'un <FsParticipant> (nom normalisé → valeur). */
export function fsdbCustom(p: XmlEl): Record<string, string> {
  const custom: Record<string, string> = {};
  for (const c of children(child(p, "FsCustomAttributes"), "FsCustomAttribute")) if (c.attrs.name) custom[norm(c.attrs.name)] = c.attrs.value ?? "";
  return custom;
}

export function fsdbPilot(p: XmlEl): PilotFields {
  const a = p.attrs;
  const custom = fsdbCustom(p);
  const pick = (...keys: string[]) => keys.map((k) => a[k] ?? custom[norm(k)]).find((v) => v !== undefined && v.trim() !== "")?.trim() ?? "";
  // « glider » contient parfois voile et sellette : « Ozone Zeno 2 / Ozone Submarine ».
  const [gliderText, harnessText] = pick("glider").split(" / ");
  const glider = splitBrand(gliderText ?? "");
  const harness = splitBrand(pick("harness", "sellette") || (harnessText ?? ""));
  const female = pick("female");
  return cleanPilot({
    pilot_key: pick("id"),
    name: pick("name"),
    gender: female === "" ? null : female === "1" || female.toLowerCase() === "true" ? "F" : "M",
    nation: pick("nat_code_3166_a3", "nation", "nat"),
    civl_id: pick("CIVLID", "civlid", "civl_id", "fai_id"),
    glider_brand: pick("glider_brand", "wing manufacturer") || glider.brand,
    glider_model: pick("glider_model", "wing model") || glider.model,
    glider_class: pick("glider_class", "class", "pg certification", "certification", "en").replace(/^EN_/, "EN-"),
    harness_brand: pick("harness_brand", "harness manufacturer") || harness.brand,
    harness_model: pick("harness_model", "harness model") || harness.model,
    weight_max: pick("ptv", "ptv max", "max weight", "weight"),
    sponsor: pick("sponsor", "team"),
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
  return queryAll<PilotRow>(db, "SELECT * FROM competition_pilots WHERE competition_id = ? ORDER BY CAST(pilot_key AS INTEGER), pilot_key", compId);
}

const FIELDS = PILOT_COLUMNS.map((c) => c.key);

/**
 * Pilotes présents dans les traces des manches mais pas dans la liste des inscrits : numéro de la trace
 * et nom le plus fréquent de leurs traces. Ils servent à remplir la liste des pilotes de la compétition.
 */
export function trackPilots(db: Db, compId: number): Array<{ pilot_key: string; name: string }> {
  const rows = db
    .prepare(
      `SELECT tr.pilot_key AS k, tr.pilot_name AS n, COUNT(*) AS c FROM tracks tr JOIN tasks t ON t.id = tr.task_id
       WHERE t.competition_id = ? AND tr.pilot_key NOT IN (SELECT pilot_key FROM competition_pilots WHERE competition_id = ?)
       GROUP BY tr.pilot_key, tr.pilot_name ORDER BY c DESC`,
    )
    .all(compId, compId) as Array<{ k: string; n: string | null; c: number }>;
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.k) || (r.n && out.get(r.k) === r.k)) out.set(r.k, r.n?.trim() || r.k);
  return [...out]
    .map(([pilot_key, name]) => ({ pilot_key, name }))
    .sort((a, b) => (Number(a.pilot_key) || Infinity) - (Number(b.pilot_key) || Infinity) || a.pilot_key.localeCompare(b.pilot_key));
}

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
  // Pilotes repris des traces (« add.<n>.<champ> ») : ajoutés à l'enregistrement, sauf case « skip.<n> ».
  const fromTracks = new Map<string, Partial<Record<keyof PilotFields, unknown>>>();
  for (const [k, v] of Object.entries(form)) {
    const a = /^add\.(\d+)\.(\w+)$/.exec(k);
    if (a && FIELDS.includes(a[2] as keyof PilotFields) && !form[`skip.${a[1]}`]) fromTracks.set(a[1]!, { ...(fromTracks.get(a[1]!) ?? {}), [a[2]!]: v === "" && a[2] === "gender" ? null : v });
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
  const imported: PilotFields[] = [];
  // Numéro d'origine (celui des traces) d'une ligne reprise des traces, si on l'a corrigé.
  const moves: Array<[string, string]> = [];
  for (const [i, raw] of fromTracks) {
    if (!String(raw.pilot_key ?? "").trim()) continue;
    const p = cleanPilot(raw);
    const from = String(form[`from.${i}`] ?? "");
    if (from && from !== p.pilot_key) moves.push([from, p.pilot_key]);
    if (seen.has(p.pilot_key) || p.pilot_key === added?.pilot_key || imported.some((x) => x.pilot_key === p.pilot_key))
      throw new FormError(t("Numéro {key} en double.", { key: p.pilot_key }));
    imported.push(p);
  }
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
  const fresh2 = [...(added ? [added] : []), ...imported];
  if (fresh2.length) upsertPilots(db, compId, fresh2);
  const move = db.prepare("UPDATE OR IGNORE tracks SET pilot_key = ? WHERE pilot_key = ? AND task_id IN (SELECT id FROM tasks WHERE competition_id = ?)");
  for (const [from, to] of moves) move.run(to, from, compId);
  return { saved: kept.length, removed: [...removed].filter((id) => own.has(id)).length, added: fresh2.length };
}

export function pilotsCsv(rows: PilotRow[]): string {
  return toCsv([PILOT_COLUMNS.map((c) => c.csv), ...rows.map((r) => PILOT_COLUMNS.map((c) => r[c.key]))]);
}
