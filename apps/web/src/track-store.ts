import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeText } from "./files.js";

/**
 * Fichiers IGC tels que reçus, hors de la base. Chaque fichier est rangé sous son empreinte
 * SHA-256 (tracks/ab/abcdef….igc.gz) : il n'est jamais modifié ni écrasé, un même fichier envoyé deux
 * fois n'est gardé qu'une fois, et l'empreinte en base prouve que le fichier n'a pas changé.
 * Une trace remplacée ou supprimée dans une manche reste dans le dossier, comme pièce reçue.
 * Les fichiers sont compressés (gzip, environ 4 fois moins de place) ; l'empreinte est celle du
 * fichier reçu, et la lecture rend ses octets exacts.
 */
export class TrackStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(sha256: string, ext = ".igc.gz"): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Empreinte invalide : ${sha256}`);
    return join(this.dir, sha256.slice(0, 2), `${sha256}${ext}`);
  }

  /** Enregistre le fichier et rend son empreinte. */
  put(bytes: Uint8Array): string {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = this.path(sha256);
    // Un fichier rangé non compressé (avant la compression) compte aussi.
    if (!existsSync(path) && !existsSync(this.path(sha256, ".igc"))) {
      mkdirSync(join(this.dir, sha256.slice(0, 2)), { recursive: true });
      // Écriture dans un fichier temporaire puis renommage : jamais de fichier à moitié écrit.
      const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, gzipSync(bytes, { level: 6 }));
      renameSync(tmp, path);
    }
    return sha256;
  }

  bytes(sha256: string): Buffer {
    const gz = this.path(sha256);
    return existsSync(gz) ? gunzipSync(readFileSync(gz)) : readFileSync(this.path(sha256, ".igc"));
  }

  text(sha256: string): string {
    return decodeText(this.bytes(sha256));
  }
}
