import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { sourceHead, ZipReader, zipStream } from "../src/zip.js";

const sample = () =>
  zipSync({
    "competition.json": strToU8('{"a":1}'),
    "tracks/m1/é été.igc": [strToU8("AXXX\nB1200000000000N00000000EA0000000000\n".repeat(500)), { level: 6 }],
    "brut.txt": [strToU8("sans compression"), { level: 0 }],
    "dossier/": new Uint8Array(0),
  });

describe("lecture d'un ZIP fichier par fichier", () => {
  it("lit les mêmes fichiers que fflate, en mémoire et sur disque", () => {
    const zip = sample();
    const ref = unzipSync(zip);
    const path = join(mkdtempSync(join(tmpdir(), "pgscore-zip-")), "a.zip");
    writeFileSync(path, zip);
    for (const src of [zip, path]) {
      ZipReader.with(src, (z) => {
        expect(z.names()).toEqual(Object.keys(ref).filter((n) => !n.endsWith("/")));
        for (const n of z.names()) expect(strFromU8(z.file(n))).toBe(strFromU8(ref[n]!));
        expect(z.size("brut.txt")).toBe(16);
      });
    }
    expect([...sourceHead(path, 2)]).toEqual([0x50, 0x4b]);
  });

  it("refuse ce qui n'est pas un ZIP", () => {
    expect(() => ZipReader.open(strToU8("PK pas vraiment un zip"))).toThrow(/pas un ZIP/);
  });

  it("construit un ZIP au fil de l'envoi, un seul fichier par nom", async () => {
    let reads = 0;
    const stream = zipStream([
      { name: "a.txt", data: () => (reads++, strToU8("premier")) },
      { name: "b.igc", data: () => (reads++, strToU8("AXXX")), level: 1 },
      { name: "a.txt", data: () => (reads++, strToU8("dernier")) },
    ]);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(["a.txt", "b.igc"]);
    expect(strFromU8(files["a.txt"]!)).toBe("dernier");
    expect(reads).toBe(2);
  });
});
