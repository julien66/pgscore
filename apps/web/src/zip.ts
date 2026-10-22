import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { Zip, ZipDeflate } from "fflate";
import { inflateRawSync } from "node:zlib";

/**
 * Lecture d'un ZIP fichier par fichier, sur disque ou en mémoire. Seul le répertoire central est lu à
 * l'ouverture ; chaque fichier n'est décompressé que quand on le demande. Une archive d'1 Go se lit
 * ainsi avec la mémoire d'un seul de ses fichiers.
 */

/** Un ZIP : chemin d'un fichier sur disque, ou ses octets. */
export type ZipSource = string | Uint8Array;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const ZIP_MAGIC = [0x50, 0x4b];

/** Les octets commencent-ils comme un ZIP (« PK ») ? */
export const isZipHead = (head: Uint8Array) => head[0] === ZIP_MAGIC[0] && head[1] === ZIP_MAGIC[1];

/** Premiers octets d'une source (fichier ou octets). */
export function sourceHead(src: ZipSource, n: number): Uint8Array {
  if (typeof src !== "string") return src.subarray(0, n);
  const fd = openSync(src, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

/** Taille d'une source en octets. */
export function sourceSize(src: ZipSource): number {
  if (typeof src !== "string") return src.length;
  const fd = openSync(src, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

/** Octets d'une source qui n'est pas un ZIP (fichier lu en entier). */
export function sourceBytes(src: ZipSource): Uint8Array {
  if (typeof src !== "string") return src;
  const size = sourceSize(src);
  const fd = openSync(src, "r");
  try {
    const buf = Buffer.alloc(size);
    let done = 0;
    while (done < size) {
      const n = readSync(fd, buf, done, size - done, done);
      if (!n) break;
      done += n;
    }
    return buf.subarray(0, done);
  } finally {
    closeSync(fd);
  }
}

export class ZipReader {
  private readonly entries = new Map<string, Entry>();
  private readonly read: (pos: number, len: number) => Buffer;
  private readonly fd: number | null;

  private constructor(src: ZipSource) {
    if (typeof src === "string") {
      const fd = openSync(src, "r");
      this.fd = fd;
      this.read = (pos, len) => {
        const buf = Buffer.alloc(len);
        let done = 0;
        while (done < len) {
          const n = readSync(fd, buf, done, len - done, pos + done);
          if (!n) throw new Error("fin de fichier inattendue");
          done += n;
        }
        return buf;
      };
      try {
        this.index(fstatSync(fd).size);
      } catch (e) {
        closeSync(fd);
        throw e;
      }
    } else {
      this.fd = null;
      const bytes = Buffer.from(src.buffer, src.byteOffset, src.byteLength);
      this.read = (pos, len) => {
        if (pos < 0 || pos + len > bytes.length) throw new Error("fin de fichier inattendue");
        return bytes.subarray(pos, pos + len);
      };
      this.index(bytes.length);
    }
  }

  /** Ouvre un ZIP ; lève une erreur si ce n'en est pas un ou s'il est abîmé. */
  static open(src: ZipSource): ZipReader {
    return new ZipReader(src);
  }

  /** Ouvre le ZIP, appelle `fn` puis le referme, même en cas d'erreur. */
  static with<T>(src: ZipSource, fn: (zip: ZipReader) => T): T {
    const zip = ZipReader.open(src);
    try {
      return fn(zip);
    } finally {
      zip.close();
    }
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
  }

  /** Noms des fichiers (pas des dossiers), dans l'ordre de l'archive. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Taille décompressée d'un fichier. */
  size(name: string): number {
    const e = this.entries.get(name);
    if (!e) throw new Error(`fichier absent : ${name}`);
    return e.size;
  }

  /** Contenu décompressé d'un fichier. */
  file(name: string): Uint8Array {
    const e = this.entries.get(name);
    if (!e) throw new Error(`fichier absent : ${name}`);
    const local = this.read(e.offset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`en-tête local abîmé : ${name}`);
    const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = this.read(start, e.compressedSize);
    let out: Uint8Array;
    if (e.method === 0) out = new Uint8Array(raw);
    else if (e.method === 8) out = inflateRawSync(raw);
    else throw new Error(`compression non prise en charge (méthode ${e.method}) : ${name}`);
    if (out.length !== e.size) throw new Error(`taille inattendue après décompression : ${name}`);
    return out;
  }

  /** Lit le répertoire central (fin de l'archive), ZIP64 compris. */
  private index(total: number) {
    // Fin du répertoire central : 22 octets plus un commentaire d'au plus 65 535 octets.
    const tailLen = Math.min(total, 22 + 0xffff);
    const tail = this.read(total - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new Error("ce n'est pas un ZIP (fin de répertoire introuvable)");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // ZIP64 : le localisateur précède la fin du répertoire classique.
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error("ZIP64 abîmé");
      const z64 = this.read(Number(tail.readBigUInt64LE(loc + 8)), 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64 abîmé");
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = this.read(cdOffset, cdSize);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("répertoire central abîmé");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      // Noms en UTF-8 si le drapeau 11 est mis, sinon en CP437 : on garde l'ASCII et le latin-1 tels quels.
      const name = flags & 0x800 ? nameBytes.toString("utf8") : nameBytes.toString("latin1");
      // Champ ZIP64 : les valeurs à 0xffffffff y sont rangées, dans cet ordre.
      let x = p + 46 + nameLen;
      const end = x + extraLen;
      while (x + 4 <= end) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (size === 0xffffffff) (size = Number(cd.readBigUInt64LE(q))), (q += 8);
          if (compressedSize === 0xffffffff) (compressedSize = Number(cd.readBigUInt64LE(q))), (q += 8);
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      if (flags & 0x1) throw new Error(`fichier chiffré : ${name}`);
      if (!name.endsWith("/")) this.entries.set(name, { name, method, compressedSize, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }
}

/**
 * ZIP construit au fil de l'envoi : chaque fichier n'est lu (par `data`) qu'au moment de l'écrire, et la
 * suite attend que le navigateur ait reçu ce qui précède. Un même nom n'est écrit qu'une fois (le dernier).
 */
export function zipStream(files: Iterable<{ name: string; data: () => Uint8Array; level?: 0 | 1 | 6 | 9 }>): ReadableStream<Uint8Array> {
  const byName = new Map<string, { name: string; data: () => Uint8Array; level?: 0 | 1 | 6 | 9 }>();
  for (const f of files) {
    byName.delete(f.name);
    byName.set(f.name, f);
  }
  const queue = byName.values();
  let zip: Zip;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) controller.error(err);
        else {
          if (chunk.length) controller.enqueue(chunk);
          if (final) controller.close();
        }
      });
    },
    pull() {
      const next = queue.next();
      if (next.done) {
        zip.end();
        return;
      }
      const f = new ZipDeflate(next.value.name, { level: next.value.level ?? 6 });
      zip.add(f);
      f.push(next.value.data(), true);
    },
  });
}
