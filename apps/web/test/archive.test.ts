import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { TrackStore } from "../src/track-store.js";

const engineFixtures = new URL("../../../packages/engine/test/fixtures/", import.meta.url);
const QR = readFileSync(new URL("pwca-gemona-2026-t3.qr.txt", engineFixtures), "utf8").trim();
const AIRSPACE = readFileSync(new URL("pwca-gemona-2026-airspace.txt", engineFixtures));
const IGC = Buffer.concat([Buffer.from("AXCT test\r\nHFDTE280726\r\nHFPLTPILOTINCHARGE:Ren"), Buffer.from([0xe9]), Buffer.from(" Test\r\nB1200004612345N01308765EA0150001600\r\n")]);

function setup() {
  const tracks = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-tracks-")));
  const db = openDb(":memory:", tracks);
  const app = createApp(db, tracks, { baseUrl: "http://localhost", devLogin: true });
  let cookie = "";
  const req = async (path: string, init: RequestInit = {}) => {
    const r = await app.request(`http://localhost${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return r;
  };
  const login = async (email: string) => {
    await req("/auth/logout", { method: "POST" });
    await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email, name: email.split("@")[0]! }) });
  };
  return { db, req, login, logout: () => req("/auth/logout", { method: "POST" }) };
}

describe("export et import de compétitions", () => {
  it("exporte une compétition complète et la réimporte à l'identique par l'API", async () => {
    const { db, req, login, logout } = setup();
    await login("orga@example.org");
    const f = new FormData();
    for (const [k, v] of Object.entries({ name: "Coupe export", location: "Gemona", start_date: "2026-07-25", end_date: "2026-08-01", nominalDistance: "60", minimumDistance: "5", nominalTime: "60", ftvFactor: "25", leadingProfile: "PWCA", airspacePenaltyRule: "pwca-soft", timeZone: "Europe/Rome" }))
      f.append(k, v);
    f.append("airspace", new Blob([AIRSPACE]), "gemona.txt");
    const compUrl = (await req("/competitions", { method: "POST", body: f })).headers.get("location")!;
    const pilots = new FormData();
    pilots.append("file", new Blob(["numero,nom,genre,nation,voile,sponsor\n12,Ana Vainqueur,F,ITA,Ozone Enzo 3,Air3\n7,Bruno Second,M,FRA,Gin Boomerang,\n"]), "pilotes.csv");
    await req(`${compUrl}/pilots/import`, { method: "POST", body: pilots });
    const ft = new FormData();
    ft.append("number", "3");
    ft.append("date", "2026-07-28");
    ft.append("text", QR);
    const taskUrl = (await req(`${compUrl}/tasks`, { method: "POST", body: ft })).headers.get("location")!.split("?")[0]!;
    const taskId = Number(taskUrl.split("/").pop());
    const up = new FormData();
    up.append("files", new Blob([IGC]), "12.igc");
    await req(`${taskUrl}/tracks`, { method: "POST", body: up });
    await req(`${taskUrl}/decisions`, { method: "POST", body: new URLSearchParams({ pilot: "7", kind: "penalty", value: "50", reason: "Retard au briefing" }) });
    const results = {
      pilots: [
        { id: "12", name: "Ana Vainqueur", total: 1000 },
        { id: "7", name: "Bruno Second", total: 640.5 },
      ],
      gap: { validity: { task: 1 }, available: { distance: 400, time: 350, leading: 250, arrival: 0 } },
    };
    db.prepare("INSERT INTO runs (task_id, status, results, started_at, finished_at) VALUES (?, 'done', ?, ?, ?)").run(taskId, JSON.stringify(results), Date.now() + 1000, Date.now() + 2000);
    await req(`${taskUrl}/official`, { method: "POST", body: new URLSearchParams({ official: "1" }) });
    const standings = await (await req(`${compUrl}/standings.csv`)).text();
    const compId = compUrl.split("/").pop();

    // Export public : lisible sans compte.
    await logout();
    const ex = await req(`/api/competitions/${compId}/export`);
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-disposition")).toContain("coupe-export.pgscore.zip");
    const zip = new Uint8Array(await ex.arrayBuffer());
    const files = unzipSync(zip);
    const a = JSON.parse(strFromU8(files["competition.json"]!));
    expect(a).toMatchObject({ format: "pgscore-competition", version: 1, competition: { name: "Coupe export", settings: { ftvFactor: 0.25, leadingProfile: "PWCA" } } });
    expect(a.pilots).toHaveLength(2);
    expect(a.rankings.map((r: { name: string }) => r.name)).toContain("Féminin");
    expect(a.tasks[0]).toMatchObject({ number: 3, official: true, decisions: [{ pilot_key: "7", kind: "penalty", value: 50 }] });
    const sha = createHash("sha256").update(IGC).digest("hex");
    expect(a.tasks[0].tracks[0]).toMatchObject({ pilot_key: "12", sha256: sha, file: `tracks/m3/${sha}.igc` });
    expect(Buffer.compare(Buffer.from(files[`tracks/m3/${sha}.igc`]!), IGC)).toBe(0);
    expect(Object.keys(unzipSync(new Uint8Array(await (await req(`/api/competitions/${compId}/export?tracks=0`)).arrayBuffer())))).toEqual(["competition.json"]);
    expect((await (await req("/api/competitions")).json())[0]).toMatchObject({ name: "Coupe export", editable: false });

    // Import : clé d'API obligatoire.
    expect((await req("/api/competitions/import", { method: "POST", body: zip })).status).toBe(401);
    expect((await req("/api/competitions", { headers: { authorization: "Bearer pgs_faux" } })).status).toBe(401);
    await login("autre@example.org");
    const page = await (await req("/account/tokens", { method: "POST", body: new URLSearchParams({ name: "script" }) })).text();
    const key = /pgs_[A-Za-z0-9_-]+/.exec(page)![0];
    await logout();
    const auth = { authorization: `Bearer ${key}` };
    const im = await req("/api/competitions/import", { method: "POST", body: zip, headers: { ...auth, "content-type": "application/zip" } });
    expect(im.status).toBe(201);
    const r = await im.json();
    expect(r).toMatchObject({ tasks: 1, pilots: 2, tracks: 1, missingTracks: 0, results: 1 });
    expect(await (await req(`/competitions/${r.id}/standings.csv`)).text()).toBe(standings);
    const newTask = db.prepare("SELECT id FROM tasks WHERE competition_id = ?").get(r.id) as { id: number };
    expect(Buffer.compare(Buffer.from(await (await req(`/tasks/${newTask.id}/files/${sha}`)).arrayBuffer()), IGC)).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_decisions WHERE task_id = ?").get(newTask.id) as { n: number }).n).toBe(1);
    // La compétition importée appartient à la clé : modifiable avec elle, pas l'originale.
    const list = (await (await req("/api/competitions", { headers: auth })).json()) as Array<{ id: number; editable: boolean }>;
    expect(list.find((x) => x.id === r.id)!.editable).toBe(true);
    expect(list.find((x) => x.id === Number(compId))!.editable).toBe(false);
    expect((await req(`/tasks/${newTask.id}/official`, { method: "POST", body: new URLSearchParams({ official: "0" }), headers: auth })).status).toBe(302);
    expect((await req(`/tasks/${taskId}/official`, { method: "POST", body: new URLSearchParams({ official: "0" }), headers: auth })).status).toBe(403);

    // Fichier modifié : empreinte refusée, rien n'est créé.
    const before = (db.prepare("SELECT COUNT(*) AS n FROM competitions").get() as { n: number }).n;
    const tampered = zipSync({ "competition.json": files["competition.json"]!, [`tracks/m3/${sha}.igc`]: strToU8("AXXX pirate\r\n") });
    const bad = await req("/api/competitions/import", { method: "POST", body: tampered, headers: auth });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("empreinte");
    expect((db.prepare("SELECT COUNT(*) AS n FROM competitions").get() as { n: number }).n).toBe(before);
  });
});
