import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { TrackStore } from "../src/track-store.js";

const QR = readFileSync(new URL("../../../packages/engine/test/fixtures/pwca-gemona-2026-t3.qr.txt", import.meta.url), "utf8").trim();

function setup() {
  const tracks = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-tracks-")));
  const db = openDb(":memory:", tracks);
  const app = createApp(db, tracks, { baseUrl: "http://localhost", devLogin: true });
  let cookie = "";
  /** Navigateur de l'organisateur (cookie de session). */
  const req = async (path: string, init: RequestInit = {}) => {
    const r = await app.request(`http://localhost${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return r;
  };
  /** Service externe : sans cookie. */
  const bot = (path: string, key: string | null, init: RequestInit = {}) =>
    app.request(`http://localhost${path}`, { ...init, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...(init.headers ?? {}) } });
  return { db, req, bot };
}

async function competitionWithTask(req: ReturnType<typeof setup>["req"], name: string) {
  await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "orga@example.org", name: "Orga" }) });
  const fc = new FormData();
  const fields = { name, nominalDistance: "60", minimumDistance: "5", nominalTime: "60", ftvFactor: "0", airspacePenaltyRule: "pwca-soft", timeZone: "Europe/Rome" };
  for (const [k, v] of Object.entries(fields)) fc.append(k, v);
  const rc = await req("/competitions", { method: "POST", body: fc });
  const compUrl = rc.headers.get("location")!;
  const ft = new FormData();
  ft.append("number", "3");
  ft.append("date", "2026-07-28");
  ft.append("text", QR);
  const rt = await req(`${compUrl}/tasks`, { method: "POST", body: ft });
  return { compUrl, taskUrl: rt.headers.get("location")!.split("?")[0]! };
}

async function newKey(req: ReturnType<typeof setup>["req"], compUrl: string): Promise<string> {
  const html = await (await req(`${compUrl}/ingest-keys`, { method: "POST", body: new URLSearchParams({ name: "bot Telegram" }) })).text();
  const key = /pgsi_[A-Za-z0-9_-]+/.exec(html)?.[0];
  expect(key).toBeTruthy();
  return key!;
}

describe("envoi par un service externe", () => {
  it("refuse sans clé d'envoi valable, y compris avec une clé d'API personnelle", async () => {
    const { req, bot } = setup();
    await competitionWithTask(req, "Coupe A");
    expect((await bot("/api/ingest", null)).status).toBe(401);
    expect((await bot("/api/ingest/tasks/3", null, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await bot("/api/ingest/tasks/3", "pgsi_inconnue", { method: "POST", body: "{}" })).status).toBe(401);
    const html = await (await req("/account/tokens", { method: "POST", body: new URLSearchParams({ name: "script" }) })).text();
    const userKey = /pgs_[A-Za-z0-9_-]+/.exec(html)![0];
    expect((await bot("/api/ingest/tasks/3", userKey, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("reçoit des éléments par manche, remplace un identifiant déjà reçu et les montre à l'organisateur", async () => {
    const { db, req, bot } = setup();
    const { compUrl, taskUrl } = await competitionWithTask(req, "Coupe A");
    const key = await newKey(req, compUrl);

    const info = (await (await bot("/api/ingest", key)).json()) as { competition: { name: string }; tasks: Array<{ number: number }> };
    expect(info.competition.name).toBe("Coupe A");
    expect(info.tasks.map((x) => x.number)).toEqual([3]);

    const items = [
      { type: "satisfaction", id: "tg-1", pilot: "42", score: 4, comment: "Belle <b>manche</b>" },
      { type: "incident", id: "inc-1", severity: "accident", description: "Arbre" },
    ];
    const r1 = await bot("/api/ingest/tasks/3", key, { method: "POST", body: JSON.stringify(items) });
    expect(r1.status).toBe(201);
    expect(((await r1.json()) as { items: Array<{ status: string }> }).items.map((x) => x.status)).toEqual(["created", "created"]);

    // Même type et même id : remplacé. Sans id : toujours ajouté. Forme { items: [...] } et objet seul acceptés.
    const r2 = await bot("/api/ingest/tasks/3", key, { method: "POST", body: JSON.stringify({ items: [{ type: "satisfaction", id: "tg-1", score: 2 }] }) });
    expect(((await r2.json()) as { items: Array<{ status: string }> }).items[0]!.status).toBe("updated");
    expect((await bot("/api/ingest/tasks/3", key, { method: "POST", body: JSON.stringify({ note: "sans type ni id" }) })).status).toBe(201);
    const rows = db.prepare("SELECT type, external_id, payload FROM task_reports ORDER BY id").all() as Array<{ type: string | null; external_id: string | null; payload: string }>;
    expect(rows.map((x) => [x.type, x.external_id])).toEqual([["satisfaction", "tg-1"], ["incident", "inc-1"], [null, null]]);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ type: "satisfaction", id: "tg-1", score: 2 });

    const edit = await (await req(`${taskUrl}/edit`)).text();
    expect(edit).toContain("Retours des pilotes et incidents (3)");
    expect(edit).toContain("inc-1");
    expect(edit).not.toContain("<b>manche</b>");
    // Pas sur la page publique de la manche.
    const pub = await (await bot(taskUrl, null, { headers: { "content-type": "text/html" } })).text();
    expect(pub).not.toContain("inc-1");

    // Suppression d'un élément par l'organisateur.
    const id = (db.prepare("SELECT id FROM task_reports WHERE external_id = 'inc-1'").get() as { id: number }).id;
    expect((await req(`${taskUrl}/reports/${id}/delete`, { method: "POST" })).status).toBe(302);
    expect((db.prepare("SELECT COUNT(*) n FROM task_reports").get() as { n: number }).n).toBe(2);
  });

  it("rejette les envois mal formés et les manches inconnues", async () => {
    const { req, bot } = setup();
    const { compUrl } = await competitionWithTask(req, "Coupe A");
    const key = await newKey(req, compUrl);
    expect((await bot("/api/ingest/tasks/9", key, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await bot("/api/ingest/tasks/3", key, { method: "POST", body: "{pas du json" })).status).toBe(400);
    expect((await bot("/api/ingest/tasks/3", key, { method: "POST", body: "[1, 2]" })).status).toBe(400);
    expect((await bot("/api/ingest/tasks/3", key, { method: "POST", body: "[]" })).status).toBe(400);
    expect((await bot("/api/ingest/tasks/3", key, { method: "POST", body: JSON.stringify({ type: { x: 1 } }) })).status).toBe(400);
    const big = JSON.stringify({ text: "x".repeat(1024 * 1024 + 10) });
    expect((await bot("/api/ingest/tasks/3", key, { method: "POST", body: big })).status).toBe(413);
  });

  it("une clé ne vaut que pour sa compétition, et plus rien une fois supprimée", async () => {
    const { db, req, bot } = setup();
    const a = await competitionWithTask(req, "Coupe A");
    const b = await competitionWithTask(req, "Coupe B");
    const keyB = await newKey(req, b.compUrl);
    expect((await bot("/api/ingest/tasks/3", keyB, { method: "POST", body: JSON.stringify({ id: "x" }) })).status).toBe(201);
    const taskB = Number(b.taskUrl.split("/").pop());
    const taskA = Number(a.taskUrl.split("/").pop());
    expect(db.prepare("SELECT task_id FROM task_reports").all()).toEqual([{ task_id: taskB }]);
    expect(taskA).not.toBe(taskB);

    const edit = await (await req(`${b.compUrl}/edit`)).text();
    expect(edit).toContain("bot Telegram");
    const kid = (db.prepare("SELECT id FROM ingest_keys").get() as { id: number }).id;
    expect((await req(`${b.compUrl}/ingest-keys/${kid}/delete`, { method: "POST" })).status).toBe(302);
    expect((await bot("/api/ingest", keyB)).status).toBe(401);
  });
});
