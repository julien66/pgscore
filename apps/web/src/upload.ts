import busboy from "busboy";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { FormError } from "./settings.js";
import { t } from "./i18n.js";

/**
 * Envois écrits sur disque au fil de l'eau : le corps de la requête n'est jamais gardé entier en
 * mémoire. Les fichiers vont dans un dossier temporaire et sont effacés par `done()` après traitement.
 */

/** Fichier reçu, rangé dans le dossier temporaire. */
export interface SavedFile {
  field: string;
  name: string;
  path: string;
  size: number;
}

export interface SavedUpload {
  fields: Record<string, string>;
  files: SavedFile[];
  /** Efface les fichiers temporaires. */
  done(): void;
}

let uploadDir = join(tmpdir(), "pgscore-uploads");

/** Dossier des fichiers temporaires ; vidé au démarrage (restes d'un envoi interrompu). */
export function setUploadDir(dir: string) {
  uploadDir = dir;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true, recursive: true });
}

/** Trop gros : l'envoi est refusé avec ce message. */
export class TooLarge extends FormError {}

const tooLarge = (max: number) => new TooLarge(t("Envoi trop gros ({n} Mo au plus).", { n: Math.round(max / 1024 / 1024) }));

/**
 * Reçoit un formulaire multipart (ou un corps brut, rangé comme un fichier du champ `file`) et écrit
 * chaque fichier sur disque. Refuse au-delà de `max` octets, comptés sur ce qui arrive vraiment.
 */
export async function saveUpload(c: Context, max: number): Promise<SavedUpload> {
  if (Number(c.req.header("content-length") ?? 0) > max) throw tooLarge(max);
  mkdirSync(uploadDir, { recursive: true });
  const fields: Record<string, string> = {};
  const files: SavedFile[] = [];
  const paths: string[] = [];
  const done = () => {
    for (const p of paths) rmSync(p, { force: true });
  };
  const body = c.req.raw.body;
  if (!body) return { fields, files, done };
  const input = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  const newPath = () => {
    const p = join(uploadDir, `${Date.now()}-${randomBytes(8).toString("hex")}`);
    paths.push(p);
    return p;
  };
  let received = 0;
  try {
    const type = c.req.header("content-type") ?? "";
    if (!type.startsWith("multipart/form-data")) {
      // Corps brut (API) : un seul fichier.
      const path = newPath();
      const out = createWriteStream(path);
      await pump(input, out, (n) => {
        received += n;
        if (received > max) throw tooLarge(max);
      });
      files.push({ field: "file", name: "upload", path, size: received });
      return { fields, files, done };
    }
    await new Promise<void>((resolve, reject) => {
      let bb: busboy.Busboy;
      try {
        bb = busboy({ headers: { "content-type": type }, defParamCharset: "utf8" });
      } catch (e) {
        reject(new FormError((e as Error).message));
        return;
      }
      const writes: Promise<void>[] = [];
      let failed = false;
      const fail = (e: unknown) => {
        if (failed) return;
        failed = true;
        input.unpipe(bb);
        input.resume();
        reject(e);
      };
      bb.on("field", (name, value) => {
        fields[name] = value;
      });
      bb.on("file", (field, stream, info) => {
        const path = newPath();
        const out = createWriteStream(path);
        const file: SavedFile = { field, name: info.filename ?? "", path, size: 0 };
        files.push(file);
        writes.push(
          pump(stream, out, (n) => {
            file.size += n;
            received += n;
            if (received > max) throw tooLarge(max);
          }).catch((e) => {
            stream.resume();
            fail(e);
          }),
        );
      });
      bb.on("error", (e) => fail(new FormError((e as Error).message)));
      bb.on("close", () => {
        Promise.all(writes).then(() => {
          if (!failed) resolve();
        }, fail);
      });
      input.on("error", fail);
      input.pipe(bb);
    });
    return { fields, files, done };
  } catch (e) {
    done();
    throw e;
  }
}

/** Copie un flux dans un fichier, en comptant les octets ; `count` peut lever une erreur pour arrêter. */
function pump(from: Readable, to: WriteStream, count: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const stop = (e: unknown) => {
      if (stopped) return;
      stopped = true;
      from.unpipe(to);
      to.destroy();
      reject(e);
    };
    from.on("data", (chunk: Buffer) => {
      try {
        count(chunk.length);
      } catch (e) {
        stop(e);
      }
    });
    from.on("error", stop);
    to.on("error", stop);
    to.on("finish", () => {
      if (!stopped) resolve();
    });
    from.pipe(to);
  });
}
