import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MIGRATIONS, openDb } from "../src/db.js";
import { TrackStore } from "../src/track-store.js";

const IGC2 = Buffer.from("AXSK other\r\nHFDTE071026\r\nHFPLTPILOTINCHARGE:Rene Test\r\nB1200004612345N01308765EA0150001600\r\nB1200014612346N01308766EA0150101601\r\n");
const TASK = JSON.stringify({ type: "race", startGates: [], turnpoints: [{ role: "sss", zone: { kind: "cylinder", radius: 2000, waypoint: { name: "S", lat: 46.1, lon: 13 } } }, { role: "goal", zone: { kind: "cylinder", radius: 400, waypoint: { name: "G", lat: 46, lon: 13 } } }] });
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

  async function minimalTask() {
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
    const task = db.prepare("INSERT INTO tasks (competition_id, number, source, source_text, task, created_at) VALUES (?, 1, 'xctsk', '', ?, 0)").run(comp.lastInsertRowid, TASK);
    return { store, db, req, url: `/tasks/${task.lastInsertRowid}` };
  }
  const upload = (name: string, bytes: Uint8Array, field = "files") => {
    const fd = new FormData();
    fd.append(field, new Blob([new Uint8Array(bytes)]), name);
    return fd;
  };

  it("enregistre l'envoi sur disque et seulement l'empreinte en base", async () => {
    const { store, db, req, url } = await minimalTask();
    const r = await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    expect(r.headers.get("location")).toContain("added=1");
    const row = db.prepare("SELECT * FROM tracks").get() as Record<string, unknown>;
    expect(row).not.toHaveProperty("igc");
    expect(row.pilot_key).toBe("42");
    expect(row.pilot_name).toBe("René Test");
    expect(row.size).toBe(IGC.length);
    expect(Buffer.compare(store.bytes(row.sha256 as string), IGC)).toBe(0);
  });

  it("remplace la trace d'un pilote et garde l'ancienne version", async () => {
    const { db, req, url } = await minimalTask();
    await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    const first = db.prepare("SELECT * FROM tracks").get() as { id: number; sha256: string };
    // Même fichier renvoyé : rien ne change.
    const same = await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    expect(same.headers.get("location")).toContain("same=1");
    // Nouvelle trace, nommée autrement, envoyée sur la ligne du pilote avec une raison.
    const fd = upload("SKYTRAXX_2026-10-07.igc", IGC2, "file");
    fd.append("note", "Trace complète reçue après la manche");
    const r = await req(`${url}/tracks/${first.id}/replace`, { method: "POST", body: fd });
    expect(r.headers.get("location")).toContain("replaced=1");
    const now = db.prepare("SELECT * FROM tracks").all() as Array<{ pilot_key: string; filename: string; note: string; sha256: string }>;
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ pilot_key: "42", pilot_name: "René Test", filename: "SKYTRAXX_2026-10-07.igc", note: "Trace complète reçue après la manche" });
    const hist = db.prepare("SELECT * FROM track_history").all() as Array<{ sha256: string; ended_how: string; ended_by: number }>;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ sha256: first.sha256, ended_how: "replaced" });
    expect(hist[0]!.ended_by).toBeTypeOf("number");
    // Les deux versions restent téléchargeables, octet pour octet.
    const oldFile = Buffer.from(await (await req(`${url}/files/${first.sha256}`)).arrayBuffer());
    expect(Buffer.compare(oldFile, IGC)).toBe(0);
    const newFile = Buffer.from(await (await req(`${url}/files/${now[0]!.sha256}`)).arrayBuffer());
    expect(Buffer.compare(newFile, IGC2)).toBe(0);
    expect((await req(`${url}/files/${"0".repeat(64)}`)).status).toBe(404);
    const page = await (await req(url)).text();
    expect(page).toContain("Anciennes versions (1)");
    expect(page).toContain("Remplacée le");
    expect(page).toContain("v2");
    // Retirer : la trace passe aussi dans l'historique.
    await req(`${url}/tracks/${first.id}/delete`, { method: "POST" });
    expect(db.prepare("SELECT COUNT(*) n FROM tracks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT ended_how FROM track_history ORDER BY id").all()).toEqual([{ ended_how: "replaced" }, { ended_how: "removed" }]);
  });

  it("refuse une archive à plusieurs traces pour un remplacement", async () => {
    const { db, req, url } = await minimalTask();
    await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    const { id } = db.prepare("SELECT id FROM tracks").get() as { id: number };
    const zip = zipSync({ "a.igc": IGC, "b.igc": IGC2 });
    const r = await req(`${url}/tracks/${id}/replace`, { method: "POST", body: upload("x.zip", zip, "file") });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("plusieurs traces");
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
