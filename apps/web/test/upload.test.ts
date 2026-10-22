import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { saveUpload, setUploadDir, TooLarge, type SavedUpload } from "../src/upload.js";

const dir = mkdtempSync(join(tmpdir(), "pgscore-up-"));
setUploadDir(dir);

/** Petite appli qui reçoit un envoi (1 Mo au plus) et garde ce qu'elle a reçu. */
function app() {
  const got: { up?: SavedUpload; error?: unknown } = {};
  const a = new Hono();
  a.post("/", async (c) => {
    try {
      got.up = await saveUpload(c, 1024 * 1024);
      return c.text("ok");
    } catch (e) {
      got.error = e;
      return c.text("non", 413);
    }
  });
  return { a, got };
}

describe("envois écrits sur disque", () => {
  it("range les fichiers d'un formulaire et les champs, puis efface les fichiers", async () => {
    const { a, got } = app();
    const f = new FormData();
    f.append("note", "trace prêtée");
    f.append("files", new Blob(["AXXX 1"]), "1.igc");
    f.append("files", new Blob(["AXXX 22"]), "22.igc");
    expect((await a.request("/", { method: "POST", body: f })).status).toBe(200);
    const up = got.up!;
    expect(up.fields.note).toBe("trace prêtée");
    expect(up.files.map((x) => [x.field, x.name, x.size])).toEqual([
      ["files", "1.igc", 6],
      ["files", "22.igc", 7],
    ]);
    expect(readFileSync(up.files[1]!.path, "utf8")).toBe("AXXX 22");
    up.done();
    expect(up.files.some((x) => existsSync(x.path))).toBe(false);
  });

  it("range un corps brut comme un fichier", async () => {
    const { a, got } = app();
    expect((await a.request("/", { method: "POST", body: new Uint8Array([0x50, 0x4b, 1, 2]), headers: { "content-type": "application/zip" } })).status).toBe(200);
    expect(got.up!.files).toMatchObject([{ field: "file", size: 4 }]);
    got.up!.done();
  });

  it("refuse au-delà de la limite, comptée sur les octets reçus, sans rien laisser sur le disque", async () => {
    const { a, got } = app();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(512 * 1024));
        c.close();
      },
    });
    const r = await a.request("/", {
      method: "POST",
      body,
      headers: { "content-type": "application/octet-stream" },
      // @ts-expect-error option de fetch de Node pour un corps en flux
      duplex: "half",
    });
    expect(r.status).toBe(413);
    expect(got.error).toBeInstanceOf(TooLarge);
    expect(readdirSync(dir)).toEqual([]);
  });
});
