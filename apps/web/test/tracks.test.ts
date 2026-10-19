import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MIGRATIONS, openDb } from "../src/db.js";
import { TrackStore } from "../src/track-store.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
// Petit IGC avec un octet latin-1 (é) dans le nom du pilote.
const IGC = Buffer.concat([Buffer.from("AXCT test\r\nHFDTE071026\r\nHFPLTPILOTINCHARGE:Ren"), Buffer.from([0xe9]), Buffer.from(" Test\r\nB1200004612345N01308765EA0150001600\r\n")]);

describe("fichiers IGC hors de la base", () => {
  it("garde le fichier reçu octet pour octet, une seule fois, sous son empreinte", () => {
    const store = new TrackStore(tmp("pgscore-store-"));
    const a = store.put(IGC);
    expect(store.put(IGC)).toBe(a);
    expect(Buffer.compare(store.bytes(a), IGC)).toBe(0);
    expect(store.text(a)).toContain("René Test");
    expect(() => store.bytes("../../etc/passwd")).toThrow();
  });

  it("enregistre l'envoi sur disque et seulement l'empreinte en base", async () => {
    const store = new TrackStore(tmp("pgscore-store-"));
    const db = openDb(":memory:", store);
    const app = createApp(db, store, { baseUrl: "http://localhost", devLogin: true });
    let cookie = "";
    const req = async (path: string, init: RequestInit = {}) => {
      const r = await app.request(`http://localhost${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
      const set = r.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!;
      return r;
    };
    await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "o@example.org", name: "O" }) });
    // Manche minimale insérée directement : seul l'envoi des traces est testé ici.
    const user = db.prepare("SELECT id FROM users").get() as { id: number };
    const comp = db.prepare("INSERT INTO competitions (owner_id, name, params, created_at) VALUES (?, 'C', '{}', 0)").run(user.id);
    const task = db.prepare("INSERT INTO tasks (competition_id, number, source, source_text, task, created_at) VALUES (?, 1, 'xctsk', '', '{}', 0)").run(comp.lastInsertRowid);
    const fd = new FormData();
    fd.append("files", new Blob([IGC]), "42.igc");
    const r = await req(`/tasks/${task.lastInsertRowid}/tracks`, { method: "POST", body: fd });
    expect(r.headers.get("location")).toContain("added=1");
    const row = db.prepare("SELECT * FROM tracks").get() as Record<string, unknown>;
    expect(row).not.toHaveProperty("igc");
    expect(row.pilot_key).toBe("42");
    expect(row.pilot_name).toBe("René Test");
    expect(row.size).toBe(IGC.length);
    expect(Buffer.compare(store.bytes(row.sha256 as string), IGC)).toBe(0);
  });

  it("sort les traces d'une base existante vers le dossier", () => {
    const dir = tmp("pgscore-migr-");
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1);");
    old.exec(MIGRATIONS[0] as string);
    old.exec(`INSERT INTO users (id, provider, subject, created_at) VALUES (1, 'dev', 'x', 0);
      INSERT INTO competitions (id, owner_id, name, params, created_at) VALUES (1, 1, 'C', '{}', 0);
      INSERT INTO tasks (id, competition_id, number, source, source_text, task, created_at) VALUES (1, 1, 1, 'xctsk', '', '{}', 0);`);
    old.prepare("INSERT INTO tracks (task_id, pilot_key, filename, igc, uploaded_at) VALUES (1, '42', '42.igc', ?, 5)").run(IGC.toString("latin1"));
    old.close();
    const store = new TrackStore(join(dir, "tracks"));
    const db = openDb(path, store);
    const row = db.prepare("SELECT * FROM tracks").get() as { sha256: string; size: number; uploaded_at: number };
    expect(row.uploaded_at).toBe(5);
    expect(Buffer.compare(store.bytes(row.sha256), IGC)).toBe(0);
    expect(existsSync(join(dir, "tracks", row.sha256.slice(0, 2), `${row.sha256}.igc`))).toBe(true);
    expect(readFileSync(path).length).toBeGreaterThan(0);
  });
});
