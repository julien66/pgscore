import { unzipSync } from "fflate";
import jpeg from "jpeg-js";
import jsQRModule from "jsqr";
import { PNG } from "pngjs";
import { t } from "./i18n.js";

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

/** Fichiers IGC d'un envoi : fichiers .igc directs et contenu des archives .zip. */
export function collectIgc(files: Array<{ name: string; bytes: Uint8Array }>): UploadedIgc[] {
  const out: UploadedIgc[] = [];
  for (const f of files) {
    const isZip = f.bytes[0] === 0x50 && f.bytes[1] === 0x4b && f.bytes[2] === 0x03 && f.bytes[3] === 0x04;
    if (isZip) {
      const entries = unzipSync(f.bytes, { filter: (e) => /\.igc$/i.test(e.name) && !e.name.startsWith("__MACOSX/") });
      for (const [name, data] of Object.entries(entries)) out.push({ filename: name.split("/").pop()!, bytes: data, text: decodeText(data) });
    } else if (/\.igc$/i.test(f.name) || /^A[A-Z0-9]{3}/.test(decodeText(f.bytes.subarray(0, 8)))) {
      // Fichier .igc, ou fichier sans extension qui commence comme un IGC (enregistrement A).
      const name = /\.igc$/i.test(f.name) ? f.name : `${f.name}.igc`;
      out.push({ filename: name, bytes: f.bytes, text: decodeText(f.bytes) });
    }
  }
  return out;
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

/**
 * Choisit le pilote d'une trace envoyée. Dans l'ordre : numéro du nom de fichier s'il est inscrit,
 * numéro de compétition de l'en-tête (HFCID) s'il est inscrit, nom de l'en-tête retrouvé parmi les
 * inscrits ; à défaut, le numéro du fichier quand le nom n'est qu'un numéro, puis le nom du pilote,
 * puis le HFCID, puis l'instrument (« XTR-ED1831420028 »). `used` (clés déjà prises : traces de la manche et du même envoi, avec le nom de leur pilote)
 * évite qu'une trace en écrase une autre : hors inscrits, la même clé ne remplace que la trace du même nom.
 */
export function pilotKeyForTrack(
  filename: string,
  text: string,
  registry: Array<{ pilot_key: string; name: string }>,
  used: Map<string, string | null> = new Map(),
): string {
  const base = filename.replace(/\.igc$/i, "").split(/[\\/]/).pop()!;
  // Nom long normalisé IGC (« 2026-05-29-XCT-ARO-01 », « …-XSD-UB5380-01 2 ») : date, fabricant,
  // instrument, numéro du vol du jour. Ce dernier n'identifie pas le pilote : on garde fabricant-instrument.
  const std = /^\d{4}-\d{2}-\d{2}-([A-Z0-9]{3})-([A-Z0-9]+)-\d{1,3}(?:[ _(]+\d+\)?)?$/i.exec(base);
  const fileKey = std ? `${std[1]}-${std[2]}`.toUpperCase() : pilotKeyFromFilename(filename);
  const { pilot, cid } = igcHeader(text);
  const keys = new Set(registry.map((p) => p.pilot_key));
  const byName = new Map(registry.map((p) => [nameKey(p.name), p.pilot_key]));
  const fromName = pilot ? byName.get(nameKey(pilot)) : undefined;
  // Numéro seul (« 260 ») ou trace de secours PWCA (« alt_1.710 » : 2e trace du pilote 710).
  const bare = /^\d+$/.test(base) || /^alt_\d+\.\d+$/i.test(base);
  let key: string;
  if (keys.has(fileKey) && (!fromName || fromName === fileKey)) key = fileKey;
  else if (cid && keys.has(cid)) key = cid;
  else if (fromName) key = fromName;
  else if (keys.has(fileKey)) key = fileKey;
  else if (bare) key = fileKey;
  else if (pilot && slug(pilot)) key = slug(pilot);
  else if (cid) key = cid;
  else key = fileKey;
  // Même clé déjà prise dans cet envoi par un autre pilote : on n'écrase pas, on distingue.
  const me = pilot ? nameKey(pilot) : null;
  if (!keys.has(key) && used.has(key) && (used.get(key) !== me || me === null)) {
    const base = key;
    for (let i = 2; used.has(key); i++) key = `${base}-${i}`;
  }
  used.set(key, me);
  return key;
}
