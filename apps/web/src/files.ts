import { unzipSync } from "fflate";
import jpeg from "jpeg-js";
import jsQRModule from "jsqr";
import { PNG } from "pngjs";

// Le paquet jsqr est en CommonJS : sa fonction est soit l'export par défaut, soit le module lui-même.
type JsQr = typeof import("jsqr").default;
const jsQR: JsQr = ((jsQRModule as unknown as { default?: JsQr }).default ?? jsQRModule) as JsQr;

/** Lecture des fichiers envoyés : image de QR code, archive de traces, texte en latin-1 ou UTF-8. */

/** Texte d'un QR code dans une image PNG ou JPEG ; null si aucun QR code n'est lisible. */
export function decodeQrImage(bytes: Uint8Array): string | null {
  let img: { width: number; height: number; data: Uint8Array | Buffer };
  if (bytes[0] === 0x89 && bytes[1] === 0x50) img = PNG.sync.read(Buffer.from(bytes));
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  else throw new Error("Image non reconnue : envoyez un PNG ou un JPEG.");
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
  text: string;
}

/** Fichiers IGC d'un envoi : fichiers .igc directs et contenu des archives .zip. */
export function collectIgc(files: Array<{ name: string; bytes: Uint8Array }>): UploadedIgc[] {
  const out: UploadedIgc[] = [];
  for (const f of files) {
    const isZip = f.bytes[0] === 0x50 && f.bytes[1] === 0x4b && f.bytes[2] === 0x03 && f.bytes[3] === 0x04;
    if (isZip) {
      const entries = unzipSync(f.bytes, { filter: (e) => /\.igc$/i.test(e.name) && !e.name.startsWith("__MACOSX/") });
      for (const [name, data] of Object.entries(entries)) out.push({ filename: name.split("/").pop()!, text: decodeText(data) });
    } else if (/\.igc$/i.test(f.name) || /^A[A-Z0-9]{3}/.test(decodeText(f.bytes.subarray(0, 8)))) {
      // Fichier .igc, ou fichier sans extension qui commence comme un IGC (enregistrement A).
      const name = /\.igc$/i.test(f.name) ? f.name : `${f.name}.igc`;
      out.push({ filename: name, text: decodeText(f.bytes) });
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
