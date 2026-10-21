import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    // Un fichier rangé non compressé (ancienne version du stockage) se relit aussi.
    const plain = new TrackStore(tmp("pgscore-store-"));
    const sha = createHash("sha256").update(IGC).digest("hex");
    mkdirSync(join(plain.dir, sha.slice(0, 2)));
    writeFileSync(join(plain.dir, sha.slice(0, 2), `${sha}.igc`), IGC);
    expect(Buffer.compare(plain.bytes(sha), IGC)).toBe(0);
    expect(plain.put(IGC)).toBe(sha);
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

  it("garde une seconde trace envoyée pour un pilote et retient la plus favorable au calcul", async () => {
    const { db, req, url } = await minimalTask();
    await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    const r = await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC2) });
    expect(r.headers.get("location")).toContain("extra=1");
    expect((db.prepare("SELECT COUNT(*) n FROM tracks WHERE pilot_key = '42'").get() as { n: number }).n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM track_history").get()).toEqual({ n: 0 });
    const page = await (await req(r.headers.get("location")!)).text();
    expect(page).toContain("le calcul retient la plus favorable");
    // Le calcul compte un seul pilote et note la trace retenue.
    await req(`${url}/runs`, { method: "POST" });
    let run: { status: string; results: string | null } | undefined;
    for (let i = 0; i < 100; i++) {
      run = db.prepare("SELECT status, results FROM runs ORDER BY id DESC LIMIT 1").get() as typeof run;
      if (run && (run.status === "done" || run.status === "error")) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(run!.status).toBe("done");
    const res = JSON.parse(run!.results!) as { pilots: Array<{ id: string }>; chosenTracks: Record<string, string> };
    expect(res.pilots.filter((p) => p.id === "42")).toHaveLength(1);
    const shas = (db.prepare("SELECT sha256 FROM tracks").all() as Array<{ sha256: string }>).map((x) => x.sha256);
    expect(shas).toContain(res.chosenTracks["42"]);
    // Liste des traces : l'une est marquée retenue, l'autre non ; la visionneuse ouvre les deux.
    const edit = await (await req(`${url}/edit`)).text();
    expect(edit).toContain(">retenue<");
    expect(edit).toContain(">non retenue<");
    expect((await req(`${url}/pilots/42`)).status).toBe(200);
  });

  it("rattache les traces aux pilotes inscrits de la compétition, par leur numéro", async () => {
    const { db, req, url } = await minimalTask();
    // Trace anonyme envoyée avant l'inscription : elle est rangée sous le nom de l'en-tête.
    await req(`${url}/tracks`, { method: "POST", body: upload("vol.igc", IGC2) });
    await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    expect((db.prepare("SELECT pilot_key FROM tracks ORDER BY id").all() as Array<{ pilot_key: string }>).map((x) => x.pilot_key)).toEqual(["rene-test", "42"]);
    const comp = (db.prepare("SELECT id FROM competitions").get() as { id: number }).id;
    // Liste des pilotes importée ensuite : la trace anonyme rejoint l'inscrit 710 (même nom), la 42 prend le nom inscrit.
    const fd = new FormData();
    fd.append("file", new Blob(["numero,nom,nation,sponsor\n710,René Test,BRA,Acme\n42,Jean Dupont,FRA,\n"]), "pilotes.csv");
    const r = await req(`/competitions/${comp}/pilots/import`, { method: "POST", body: fd });
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("1 trace rattachée");
    const rows = db.prepare("SELECT pilot_key, pilot_name FROM tracks ORDER BY id").all();
    expect(rows).toEqual([
      { pilot_key: "710", pilot_name: "René Test" },
      { pilot_key: "42", pilot_name: "Jean Dupont" },
    ]);
    // Rattachement à la main depuis la liste des traces.
    const id = (db.prepare("SELECT id FROM tracks WHERE pilot_key = '42'").get() as { id: number }).id;
    const a = await req(`${url}/tracks/${id}/pilot`, { method: "POST", body: new URLSearchParams({ pilot_key: "710" }) });
    expect(a.headers.get("location")).toContain("assigned=1");
    expect((db.prepare("SELECT COUNT(*) n FROM tracks WHERE pilot_key = '710'").get() as { n: number }).n).toBe(2);
    expect((await req(`${url}/tracks/${id}/pilot`, { method: "POST", body: new URLSearchParams({ pilot_key: "999" }) })).status).toBe(400);
    // Page des traces : nation et sponsor de l'inscrit, choix du pilote.
    const page = await (await req(`${url}/edit`)).text();
    expect(page).toContain("BRA · Acme");
    expect(page).toContain("Changer de pilote");
  });

  it("propose les pilotes des traces dans la liste des pilotes de la compétition", async () => {
    const { db, req, url } = await minimalTask();
    await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    await req(`${url}/tracks`, { method: "POST", body: upload("vol.igc", IGC2) });
    const comp = (db.prepare("SELECT id FROM competitions").get() as { id: number }).id;
    const page = await (await req(`/competitions/${comp}/edit`)).text();
    expect(page).toContain("2 pilotes des traces à inscrire");
    expect(page).toContain('name="add.0.pilot_key" value="42"');
    expect(page).toContain('name="add.1.pilot_key" value="rene-test"');
    // Enregistrement : 42 inscrit avec son sponsor, la trace « rene-test » corrigée en 710 la suit.
    const body = new URLSearchParams({ "add.0.pilot_key": "42", "add.0.name": "René Test", "add.0.sponsor": "Acme", "add.1.pilot_key": "710", "add.1.name": "Rene Test" });
    const r = await req(`/competitions/${comp}/pilots`, { method: "POST", body });
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("2 pilotes ajoutés");
    expect(db.prepare("SELECT pilot_key, sponsor FROM competition_pilots ORDER BY id").all()).toEqual([
      { pilot_key: "42", sponsor: "Acme" },
      { pilot_key: "710", sponsor: null },
    ]);
    expect((db.prepare("SELECT pilot_key FROM tracks ORDER BY id").all() as Array<{ pilot_key: string }>).map((x) => x.pilot_key)).toEqual(["42", "710"]);
    expect(await (await req(`/competitions/${comp}/edit`)).text()).not.toContain("depuis les traces");
  });

  it("signale les traces sans pilote inscrit et les rattache d'un clic", async () => {
    const { db, req, url } = await minimalTask();
    const comp = (db.prepare("SELECT id FROM competitions").get() as { id: number }).id;
    db.prepare("INSERT INTO competition_pilots (competition_id, pilot_key, name) VALUES (?, '5', 'Autre Pilote')").run(comp);
    await req(`${url}/tracks`, { method: "POST", body: upload("vol.igc", IGC2) });
    const page = await (await req(`${url}/edit`)).text();
    expect(page).toContain("non inscrit");
    expect(page).toContain("Rattacher aux inscrits");
    // Rien à rattacher tant que l'inscrit manque ; ensuite, le bouton le fait.
    expect((await req(`${url}/tracks/link`, { method: "POST" })).headers.get("location")).toContain("linked=0");
    db.prepare("INSERT INTO competition_pilots (competition_id, pilot_key, name) VALUES (?, '710', 'TEST René')").run(comp);
    expect((await req(`${url}/tracks/link`, { method: "POST" })).headers.get("location")).toContain("linked=1");
    expect(db.prepare("SELECT pilot_key, pilot_name FROM tracks").get()).toEqual({ pilot_key: "710", pilot_name: "TEST René" });
  });

  it("recalcule toutes les manches de la compétition et montre l'avancement", async () => {
    const { db, req, url } = await minimalTask();
    await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    const compId = (db.prepare("SELECT competition_id FROM tasks").get() as { competition_id: number }).competition_id;
    const r = await req(`/competitions/${compId}/runs`, { method: "POST" });
    expect(r.headers.get("location")).toBe(`/competitions/${compId}`);
    const page = await (await req(`/competitions/${compId}`)).text();
    expect(page).toContain('id="comp-runs"');
    let runs: Array<{ status: string; number: number }> = [];
    for (let i = 0; i < 100; i++) {
      runs = await (await req(`/competitions/${compId}/runs.json`)).json();
      if (runs.every((x) => x.status === "done" || x.status === "error")) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(runs).toMatchObject([{ number: 1, status: "done" }]);
    // Calculs finis : plus de bloc d'attente, et le bouton reste là pour relancer.
    const after = await (await req(`/competitions/${compId}`)).text();
    expect(after).not.toContain('id="comp-runs"');
    expect(after).toContain("Recalculer toutes les manches");
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
    const page = await (await req(`${url}/edit`)).text();
    expect(page).toContain("Anciennes versions (1)");
    expect(page).toContain("Remplacée le");
    expect(page).toContain("v2");
    // La page du pilote porte les deux versions, celle en vigueur d'abord.
    const viewer = await (await req(`${url}/pilots/42`)).text();
    const data = JSON.parse(/<script type="application\/json" id="viewer-data">(.*?)<\/script>/s.exec(viewer)![1]!.replace(/\\u003c/g, "<"));
    expect(data.versions.map((v: { sha256: string; status: string }) => [v.sha256, v.status])).toEqual([
      [now[0]!.sha256, "current"],
      [first.sha256, "replaced"],
    ]);
    // Retirer : la trace passe aussi dans l'historique.
    await req(`${url}/tracks/${first.id}/delete`, { method: "POST" });
    expect(db.prepare("SELECT COUNT(*) n FROM tracks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT ended_how FROM track_history ORDER BY id").all()).toEqual([{ ended_how: "replaced" }, { ended_how: "removed" }]);
    // Une trace retirée reste consultable.
    expect((await req(`${url}/pilots/42`)).status).toBe(200);
    expect((await req(`${url}/pilots/999`)).status).toBe(404);
  });

  it("retire toutes les traces de la manche d'un coup, en les gardant dans l'historique", async () => {
    const { db, req, url } = await minimalTask();
    await req(`${url}/tracks`, { method: "POST", body: upload("42.igc", IGC) });
    await req(`${url}/tracks`, { method: "POST", body: upload("43.igc", IGC2) });
    expect(db.prepare("SELECT COUNT(*) n FROM tracks").get()).toEqual({ n: 2 });
    const page = await (await req(`${url}/edit`)).text();
    expect(page).toContain(`action="${url}/tracks/delete-all"`);
    expect(page).toContain("Retirer les 2 traces de cette manche ?");
    const r = await req(`${url}/tracks/delete-all`, { method: "POST" });
    expect(r.status).toBe(302);
    expect(db.prepare("SELECT COUNT(*) n FROM tracks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT pilot_key, ended_how FROM track_history ORDER BY pilot_key").all()).toEqual([
      { pilot_key: "42", ended_how: "removed" },
      { pilot_key: "43", ended_how: "removed" },
    ]);
    expect(await (await req(`${url}/edit`)).text()).not.toContain("/tracks/delete-all");
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
    expect(existsSync(join(dir, "tracks", row.sha256.slice(0, 2), `${row.sha256}.igc.gz`))).toBe(true);
    expect(readFileSync(path).length).toBeGreaterThan(0);
  });
});
