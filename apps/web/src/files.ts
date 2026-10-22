import jpeg from "jpeg-js";
import jsQRModule from "jsqr";
import { PNG } from "pngjs";
import { t } from "./i18n.js";
import { decodeFsName } from "./text.js";
import { isZipHead, sourceBytes, sourceHead, ZipReader, type ZipSource } from "./zip.js";

// Le paquet jsqr est en CommonJS : sa fonction est soit l'export par défaut, soit le module lui-même.
type JsQr = typeof import("jsqr").default;
const jsQR: JsQr = ((jsQRModule as unknown as { default?: JsQr }).default ?? jsQRModule) as JsQr;

/** Lecture des fichiers envoyés : image de QR code, archive de traces, texte en latin-1 ou UTF-8. */

/** Texte d'un QR code dans une image PNG ou JPEG ; null si aucun QR code n'est lisible. */
export function decodeQrImage(bytes: Uint8Array): string | null {
  let img: { width: number; height: number; data: Uint8Array | Buffer };
  if (bytes[0] === 0x89 && bytes[1] === 0x50) img = PNG.sync.read(Buffer.from(bytes));
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  else throw new Error(t("Image non reconnue : envoyez un PNG ou un JPEG."));
  const data = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const r = jsQR(data, img.width, img.height, { inversionAttempts: "attemptBoth" });
  return r?.data ?? null;
}

/** Texte d'un fichier : UTF-8 s'il est valide, sinon latin-1 (fréquent dans les IGC). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

export interface UploadedIgc {
  filename: string;
  /** Fichier tel que reçu, gardé à l'identique. */
  bytes: Uint8Array;
  text: string;
}

/**
 * Fichiers IGC d'un envoi, un par un : fichiers .igc directs et contenu des archives .zip (lues fichier
 * par fichier). `fn` reçoit chaque trace ; elle n'est plus gardée en mémoire ensuite.
 */
export function forEachIgc(files: Array<{ name: string; src: ZipSource }>, fn: (g: UploadedIgc) => void): void {
  for (const f of files) {
    const head = sourceHead(f.src, 8);
    if (isZipHead(head) && head[2] === 0x03 && head[3] === 0x04) {
      ZipReader.with(f.src, (zip) => {
        for (const name of zip.names()) {
          if (!/\.igc$/i.test(name) || name.startsWith("__MACOSX/")) continue;
          const data = zip.file(name);
          fn({ filename: name.split("/").pop()!, bytes: data, text: decodeText(data) });
        }
      });
    } else if (/\.igc$/i.test(f.name) || /^A[A-Z0-9]{3}/.test(decodeText(head))) {
      // Fichier .igc, ou fichier sans extension qui commence comme un IGC (enregistrement A).
      const name = /\.igc$/i.test(f.name) ? f.name : `${f.name}.igc`;
      const bytes = sourceBytes(f.src);
      fn({ filename: name, bytes, text: decodeText(bytes) });
    }
  }
}

/** Fichiers IGC d'un envoi, tous en mémoire (petits envois et tests). */
export function collectIgc(files: Array<{ name: string; bytes: Uint8Array }>): UploadedIgc[] {
  const out: UploadedIgc[] = [];
  forEachIgc(
    files.map((f) => ({ name: f.name, src: f.bytes })),
    (g) => out.push(g),
  );
  return out;
}

/**
 * En-tête d'un IGC (tout ce qui précède le premier point B), copié : c'est tout ce qu'il faut pour
 * reconnaître le pilote, sans garder la trace entière en mémoire.
 */
export function igcHeaderText(text: string): string {
  const i = text.search(/^B\d{6}/m);
  const h = i < 0 ? text.slice(0, 16384) : text.slice(0, Math.min(i, 16384));
  // Copie à plat : une sous-chaîne garderait sinon tout le texte de la trace en mémoire.
  return Buffer.from(h, "utf16le").toString("utf16le");
}

/**
 * Clé du pilote à partir du nom de fichier : numéro de dossard si le fichier en porte un
 * (« 260.igc », « alt_1.775.igc » comme dans les archives PWCA), sinon le nom sans extension.
 */
export function pilotKeyFromFilename(filename: string): string {
  const base = filename.replace(/\.igc$/i, "");
  const m = /(?:^|[._-])(\d+)$/.exec(base);
  return m ? m[1]! : base;
}

/** Nom pour comparer : sans accents, casse ni ponctuation, mots triés (« DUPONT Jean » = « Jean Dupont »). */
export const nameKey = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** En-tête IGC : pilote (HFPLT) et numéro de compétition (HFCID). */
export function igcHeader(text: string): { pilot: string | null; cid: string | null } {
  const v = (re: RegExp) => re.exec(text)?.[1]?.trim() || null;
  const pilot = v(/^HF[A-Z]{0,3}PLT[^:]*:(.*)$/im);
  const cid = v(/^HF[A-Z]{0,3}CID[^:]*:(.*)$/im);
  const empty = /^(not ?set|unknown|pilot|nil|nkn|none|n\/?a|-+)$/i;
  return { pilot: pilot && !empty.test(pilot) ? pilot : null, cid: cid && !empty.test(cid) && /^[\w-]{1,12}$/.test(cid) ? cid : null };
}

/** Nom de fichier sans dossier ni extension ; « #U00e4 » (accents encodés par FS) redevient « ä ». */
const baseName = (filename: string) => decodeFsName(filename.split(/[\\/]/).pop()!.replace(/\.igc$/i, ""));

/** Numéro sans zéros devant (« 007 » = « 7 »), pour comparer nom de fichier, HFCID et inscrits. */
const normId = (v: string) => (/^\d+$/.test(v) ? v.replace(/^0+(?=\d)/, "") : v);

// Nom long normalisé IGC (« 2026-05-29-XCT-ARO-01 », « …-XSD-UB5380-01 2 ») : date, fabricant,
// instrument, numéro du vol du jour. Ce dernier n'identifie pas le pilote : on garde fabricant-instrument.
const STD_NAME = /^\d{4}-\d{2}-\d{2}-([A-Z0-9]{3})-([A-Z0-9]+)-\d{1,3}(?:[ _(]+\d+\)?)?$/i;

/** Mots d'un nom de fichier qui ne sont jamais un nom de pilote. */
const NOT_A_NAME = new Set(["livetrack", "igc", "track", "tracklog", "alt", "flight", "vol", "task", "manche", "xcontest", "flymaster"]);

/** Nom de pilote lisible dans un nom de fichier (« albert_nazander_2026-06-21_01.24 » → « albert nazander ») ; null s'il n'y en a pas. */
export function filenamePilotName(filename: string): string | null {
  const base = baseName(filename);
  if (STD_NAME.test(base)) return null;
  const words = (base.match(/\p{L}+/gu) ?? []).filter((w) => w.length > 1 && !NOT_A_NAME.has(w.toLowerCase()));
  return words.length ? words.join(" ") : null;
}

/**
 * Inscrit dont le nom correspond : nom complet (ordre, casse et accents ignorés), sinon le seul inscrit
 * dont le nom contient tous les mots du nom de fichier (« T_o_Bouvard » pour « Téo BOUVARD », accent perdu), ou l'inverse.
 */
function registryByName(name: string, registry: Array<{ pilot_key: string; name: string }>): string | undefined {
  const key = nameKey(name);
  const exact = registry.find((p) => nameKey(p.name) === key);
  if (exact) return exact.pilot_key;
  const words = key.split(" ").filter((w) => w.length >= 3);
  if (!words.length) return undefined;
  const mine = new Set(key.split(" "));
  // Tous les mots du fichier dans le nom de l'inscrit, ou tous ceux de l'inscrit dans le fichier (« Filipe Ribeiro - Phil »).
  const hits = registry.filter((p) => {
    const own = nameKey(p.name).split(" ");
    const ownSet = new Set(own);
    const long = own.filter((w) => w.length >= 3);
    return words.every((w) => ownSet.has(w)) || (long.length > 0 && long.every((w) => mine.has(w)));
  });
  return hits.length === 1 ? hits[0]!.pilot_key : undefined;
}

/**
 * Inscrit sans numéro : inscrit d'office sous le nom de sa trace (clé = nom en minuscules avec tirets,
 * « albert-nazander »). Un numéro trouvé plus tard dans une trace doit pouvoir le remplacer.
 */
export const isPlaceholderPilot = (p: { pilot_key: string; name: string }) => !/^\d+$/.test(p.pilot_key) && p.pilot_key === slug(p.name);

/** Morceaux de la date du vol (HFDTE) tels qu'ils apparaissent dans un nom de fichier : « 2026 », « 06 », « 21 », « 20260621 »… */
function dateParts(text: string | undefined): Set<string> {
  const m = text ? /^HFDTE(?:DATE:)?(\d{2})(\d{2})(\d{2})/m.exec(text) : null;
  if (!m) return new Set();
  const [dd, mm, yy] = [m[1]!, m[2]!, m[3]!];
  const yyyy = `${Number(yy) >= 80 ? 19 : 20}${yy}`;
  return new Set([dd, mm, yy, yyyy, `${yyyy}${mm}${dd}`, `${yy}${mm}${dd}`, `${dd}${mm}${yy}`, `${dd}${mm}${yyyy}`, `${mm}${dd}`, `${dd}${mm}`].map(normId));
}
const looksLikeDate = (v: string) => /^(19|20)\d{2}$/.test(v) || /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(v);

/** Place du numéro du pilote parmi les nombres du nom de fichier : n-ième en partant du début ou de la fin. */
export interface FilenameSlot {
  from: "start" | "end";
  i: number;
}
/**
 * Convention de nommage apprise sur un lot de traces. `evidence` : traces dont l'identité connue
 * (HFCID, inscrit) confirme la place. `confident` : place confirmée, ou devinée sur au moins trois
 * fichiers sans rien contre elle ; le numéro sert alors de clé même pour un pilote pas encore inscrit.
 */
export interface FilenameConvention {
  slot: FilenameSlot | null;
  evidence: number;
  confident: boolean;
}

const numbersOf = (filename: string) => baseName(filename).match(/\d+/g) ?? [];
const atSlot = (nums: string[], s: FilenameSlot) => (s.from === "start" ? nums[s.i] : nums[nums.length - 1 - s.i]);

/** Numéro du pilote lu dans un nom de fichier selon une convention apprise ; null si la convention n'en trouve pas. */
export function filenameId(filename: string, conv: FilenameConvention): string | null {
  if (!conv.slot) return null;
  const v = atSlot(numbersOf(filename), conv.slot);
  return v === undefined ? null : normId(v);
}

/**
 * Apprend sur tout un lot de traces où se trouve le numéro du pilote dans le nom des fichiers.
 * Chaque place possible (1er, 2e… nombre depuis le début ou la fin) est comparée à ce qu'on sait déjà
 * de chaque trace : HFCID de l'en-tête, pilote inscrit retrouvé par le nom (en-tête ou fichier), clé
 * déjà donnée (`knownId`). La place qui s'accorde le mieux l'emporte. Sans rien pour confirmer, on
 * écarte les nombres qui sont la date du vol, ceux qui se répètent d'une trace à l'autre (numéro du
 * vol du jour), les heures et minutes (« 13.24 ») et les longs nombres (heure « 221753 ») ; le dernier nombre reste le choix par défaut.
 */
export function learnFilenameConvention(
  samples: Array<{ filename: string; text?: string; knownId?: string | null }>,
  allRegistry: Array<{ pilot_key: string; name: string }>,
): FilenameConvention {
  // Les inscrits d'office sous leur nom (« albert-nazander ») n'ont pas de numéro : ils ne confirment rien.
  const registry = allRegistry.filter((p) => !isPlaceholderPilot(p));
  const keys = new Set(registry.map((p) => normId(p.pilot_key)));
  const byName = new Map(registry.map((p) => [nameKey(p.name), p.pilot_key]));
  const rows = samples
    .filter((s) => !STD_NAME.test(baseName(s.filename)))
    .map((s) => {
      const h = s.text ? igcHeader(s.text) : { pilot: null, cid: null };
      let known = s.knownId ? normId(s.knownId) : null;
      const cid = h.cid ? normId(h.cid) : null;
      if (!known && cid && (!keys.size || keys.has(cid))) known = cid;
      if (!known && h.pilot) known = byName.get(nameKey(h.pilot)) ?? null;
      const fname = !known && keys.size ? filenamePilotName(s.filename) : null;
      if (!known && fname) known = registryByName(fname, registry) ?? null;
      return { nums: numbersOf(s.filename), dates: dateParts(s.text), known: known ? normId(known) : null };
    });
  // Fichiers sans aucun nombre (« T_o_Bouvard.igc ») : ils ne disent rien de la place du numéro.
  const numbered = rows.filter((r) => r.nums.length).length;
  if (!numbered) return { slot: null, evidence: 0, confident: false };
  const slots: FilenameSlot[] = [0, 1, 2, 3].flatMap((i) => [{ from: "end" as const, i }, { from: "start" as const, i }]);
  let best: { slot: FilenameSlot; score: number; evidence: number; confident: boolean } | null = null;
  for (const slot of slots) {
    const raw = rows.map((r) => atSlot(r.nums, slot));
    const vals = raw.map((v) => (v === undefined ? null : normId(v)));
    const defined = vals.filter((v): v is string => v !== null);
    const n = defined.length;
    if (!n || n < 0.8 * numbered) continue;
    let agree = 0;
    let disagree = 0;
    let regHits = 0;
    let dateLike = 0;
    let timeLike = 0;
    rows.forEach((r, k) => {
      const v = vals[k];
      if (v === null || v === undefined) return;
      // « 13.24 » : heures puis minutes, deux nombres de deux chiffres.
      const at = slot.from === "start" ? slot.i : r.nums.length - 1 - slot.i;
      const prev = r.nums[at - 1];
      if (prev && /^\d{2}$/.test(prev) && /^\d{2}$/.test(raw[k]!) && Number(prev) <= 23 && Number(v) <= 59) timeLike++;
      if (r.dates.has(v) || (!r.dates.size && looksLikeDate(v))) dateLike++;
      if (r.known) v === r.known ? agree++ : disagree++;
      else if (keys.has(v)) regHits++;
    });
    const distinct = new Set(defined).size / n;
    if (dateLike > n / 2) continue;
    if (n >= 3 && distinct < 0.5) continue;
    if (disagree > 0.2 * (agree + disagree)) continue;
    const evidence = agree + regHits;
    if (!evidence) {
      // Rien pour confirmer : un numéro de pilote est court et différent pour chaque trace.
      if (n >= 3 && distinct < 0.9) continue;
      if (defined.filter((v) => v.length > 5).length > n / 2) continue;
      if (timeLike > n / 2) continue;
    }
    const score = 3 * agree - 5 * disagree + regHits;
    if (!best || score > best.score) best = { slot, score, evidence, confident: evidence > 0 || n >= 3 };
  }
  return best ? { slot: best.slot, evidence: best.evidence, confident: best.confident } : { slot: null, evidence: 0, confident: false };
}

/**
 * Choisit le pilote d'une trace envoyée. L'en-tête d'abord : numéro de compétition (HFCID) s'il est
 * inscrit (ou s'il n'y a encore aucun inscrit). Puis le numéro du nom de fichier s'il est inscrit,
 * le nom de l'en-tête ou du fichier retrouvé parmi les inscrits ; à défaut, le numéro du fichier quand le
 * nom n'est qu'un numéro (ou que la convention du lot l'a confirmé), puis le nom du pilote, puis le
 * HFCID, puis l'instrument (« XTR-ED1831420028 »). `conv` : convention de nommage apprise sur tout le
 * lot (`learnFilenameConvention`) ; sans elle, le dernier nombre du nom de fichier. `used` (clés déjà
 * prises : traces de la manche et du même envoi, avec le nom de leur pilote) évite qu'une trace en
 * écrase une autre : hors inscrits, la même clé ne remplace que la trace du même nom.
 */
export function pilotKeyForTrack(
  filename: string,
  text: string,
  allRegistry: Array<{ pilot_key: string; name: string }>,
  used: Map<string, string | null> = new Map(),
  conv?: FilenameConvention,
): string {
  const base = filename.replace(/\.igc$/i, "").split(/[\\/]/).pop()!;
  const std = STD_NAME.exec(base);
  let fileKey: string;
  let learned = false;
  if (std) fileKey = `${std[1]}-${std[2]}`.toUpperCase();
  else if (conv) {
    const id = filenameId(filename, conv);
    learned = id !== null && conv.confident;
    fileKey = id ?? base;
  } else fileKey = pilotKeyFromFilename(filename);
  const { pilot, cid: rawCid } = igcHeader(text);
  const cid = rawCid ? normId(rawCid) : null;
  // Inscrits d'office sous le nom de leur trace (« albert-nazander ») : pas encore de numéro. Un numéro
  // lu dans la trace (HFCID, convention du lot) passe avant eux ; registerTrackPilots leur donne ensuite ce numéro.
  const registry = allRegistry.filter((p) => !isPlaceholderPilot(p));
  const placeholders = allRegistry.filter(isPlaceholderPilot);
  const keys = new Set(registry.map((p) => p.pilot_key));
  const byName = new Map(registry.map((p) => [nameKey(p.name), p.pilot_key]));
  const fromName = pilot ? byName.get(nameKey(pilot)) : undefined;
  const fileName = std ? null : filenamePilotName(filename);
  const fromFileName = fileName ? registryByName(fileName, registry) : undefined;
  // Numéro seul (« 260 ») ou trace de secours PWCA (« alt_1.710 » : 2e trace du pilote 710).
  const bare = /^\d+$/.test(base) || /^alt_\d+\.\d+$/i.test(base);
  let key: string;
  let strong = false;
  // HFCID d'abord, sauf si le nom de l'en-tête et le numéro du fichier désignent ensemble un autre inscrit (instrument prêté).
  if (cid && (keys.has(cid) || !keys.size) && !(fromName && fromName !== cid && fromName === fileKey)) {
    key = cid;
    strong = true;
  }
  else if (keys.has(fileKey) && (!fromName || fromName === fileKey)) key = fileKey;
  // Fichier nommé par un numéro pas encore inscrit (archive PWCA) : ce numéro est celui du pilote.
  else if (bare && !keys.has(fileKey)) key = fileKey;
  else if (fromName) key = fromName;
  else if (fromFileName) key = fromFileName;
  else if (keys.has(fileKey)) key = fileKey;
  else if (bare || learned) {
    key = fileKey;
    strong = learned;
  }
  else if ((pilot || fileName) && registryByName((pilot || fileName)!, placeholders)) key = registryByName((pilot || fileName)!, placeholders)!;
  else if (pilot && slug(pilot)) key = slug(pilot);
  else if (cid) key = cid;
  else key = fileKey;
  // Même clé déjà prise dans cet envoi par un autre pilote : on n'écrase pas, on distingue. Un numéro
  // sûr (HFCID, convention confirmée) désigne bien le même pilote : ses traces vont ensemble.
  const me = pilot ? nameKey(pilot) : null;
  if (!strong && !keys.has(key) && used.has(key) && (used.get(key) !== me || me === null)) {
    const base = key;
    for (let i = 2; used.has(key); i++) key = `${base}-${i}`;
  }
  used.set(key, me);
  return key;
}
