import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { nameScore } from "../src/reports.js";
import { TrackStore } from "../src/track-store.js";

const QR = readFileSync(new URL("../../../packages/engine/test/fixtures/pwca-gemona-2026-t3.qr.txt", import.meta.url), "utf8").trim();

function setup() {
  const tracks = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-tracks-")));
  const db = openDb(":memory:", tracks);
  const app = createApp(db, tracks, { baseUrl: "http://localhost", devLogin: true, adminEmails: ["admin@example.org"] });
  let cookie = "";
  /** Navigateur (cookie de session). */
  const req = async (path: string, init: RequestInit = {}) => {
    const r = await app.request(`http://localhost${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return r;
  };
  const login = (email: string) => req("/auth/dev", { method: "POST", body: new URLSearchParams({ email, name: email }) });
  /** Service externe : sans cookie. */
  const bot = (key: string | null, body?: unknown, raw?: string) =>
    app.request("http://localhost/api/ingest", {
      method: body === undefined && raw === undefined ? "GET" : "POST",
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
      ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { db, req, login, bot };
}

type Setup = ReturnType<typeof setup>;

async function competition(req: Setup["req"], name: string, start: string, end: string) {
  const fc = new FormData();
  const fields = { name, start_date: start, end_date: end, nominalDistance: "60", minimumDistance: "5", nominalTime: "60", ftvFactor: "0", airspacePenaltyRule: "pwca-soft", timeZone: "Europe/Rome" };
  for (const [k, v] of Object.entries(fields)) fc.append(k, v);
  return (await req("/competitions", { method: "POST", body: fc })).headers.get("location")!;
}

async function task(req: Setup["req"], compUrl: string, number: number, date: string) {
  const ft = new FormData();
  ft.append("number", String(number));
  ft.append("date", date);
  ft.append("text", QR);
  const loc = (await req(`${compUrl}/tasks`, { method: "POST", body: ft })).headers.get("location")!;
  return { url: loc.split("?")[0]!, id: Number(loc.split("?")[0]!.split("/").pop()) };
}

async function adminKey(s: Setup): Promise<string> {
  await s.login("admin@example.org");
  const html = await (await s.req("/admin/ingest/keys", { method: "POST", body: new URLSearchParams({ name: "bot Telegram" }) })).text();
  const key = /pgsi_[A-Za-z0-9_-]+/.exec(html)?.[0];
  expect(key).toBeTruthy();
  return key!;
}

type Resp = { items: Array<{ status: string; competition: number | null; task: number | null }> };

describe("service externe", () => {
  it("compare les noms sans accents ni casse, mot à mot", () => {
    expect(nameScore("PWC Gemona 2026", "Coupe du monde PWCA – Gemona 2026")).toBeCloseTo(2 / 3);
    expect(nameScore("Trophées des Cimes", "French Open - Trophees des Cimes 2026")).toBe(1);
    expect(nameScore("Open de Baixo", "German Open 2026")).toBe(0.5);
  });

  it("clés réservées aux administrateurs ; refuse sans clé d'envoi valable, y compris une clé d'API personnelle", async () => {
    const s = setup();
    await s.login("orga@example.org");
    expect((await s.req("/admin/ingest")).status).toBe(404);
    expect((await s.req("/admin/ingest/keys", { method: "POST", body: new URLSearchParams({ name: "x" }) })).status).toBe(404);
    const html = await (await s.req("/account/tokens", { method: "POST", body: new URLSearchParams({ name: "script" }) })).text();
    expect(html).not.toContain("/admin/ingest");
    const userKey = /pgs_[A-Za-z0-9_-]+/.exec(html)![0];
    expect((await s.bot(null)).status).toBe(401);
    expect((await s.bot(null, {})).status).toBe(401);
    expect((await s.bot("pgsi_inconnue", {})).status).toBe(401);
    expect((await s.bot(userKey, {})).status).toBe(401);
    const key = await adminKey(s);
    expect(await (await s.req("/account")).text()).toContain("/admin/ingest");
    expect((await s.bot(key)).status).toBe(200);
    const kid = (s.db.prepare("SELECT id FROM ingest_keys").get() as { id: number }).id;
    await s.req(`/admin/ingest/keys/${kid}/delete`, { method: "POST" });
    expect((await s.bot(key)).status).toBe(401);
  });

  it("rattache chaque élément à la compétition et à la manche par le nom de l'événement et la date", async () => {
    const s = setup();
    const key = await adminKey(s);
    const gemona = await competition(s.req, "PWCA Gemona 2026", "2026-07-25", "2026-08-01");
    const feltre = await competition(s.req, "PWCA Feltre 2026", "2026-07-25", "2026-08-01");
    const t3 = await task(s.req, gemona, 3, "2026-07-28");
    await task(s.req, feltre, 3, "2026-07-28");

    const known = (await (await s.bot(key)).json()) as { competitions: Array<{ name: string; tasks: Array<{ number: number }> }> };
    expect(known.competitions.map((x) => x.name).sort()).toEqual(["PWCA Feltre 2026", "PWCA Gemona 2026"]);

    const r = await s.bot(key, [
      { type: "satisfaction", id: "tg-1", event: "PWC Gemona", date: "2026-07-28", score: 4, comment: "Belle <b>manche</b>" },
      { type: "incident", id: "inc-1", competition: "gemona", date: "2026-07-28T14:32:00Z", description: "Arbre" },
      // Jour sans manche : compétition trouvée, manche non.
      { type: "satisfaction", id: "tg-2", event: "Gemona", date: "2026-07-30", score: 3 },
      // Nom qui ne départage pas Gemona et Feltre, nom inconnu, ni nom ni date : en attente.
      { type: "satisfaction", id: "tg-3", event: "PWCA 2026", date: "2026-07-28" },
      { type: "satisfaction", id: "tg-4", event: "Open de Kastania", date: "2026-07-28" },
      { note: "sans rien" },
    ]);
    expect(r.status).toBe(201);
    const items = ((await r.json()) as Resp).items;
    const compId = Number(gemona.split("/").pop());
    expect(items.map((x) => [x.status, x.competition, x.task])).toEqual([
      ["created", compId, 3],
      ["created", compId, 3],
      ["created", compId, null],
      ["created", null, null],
      ["created", null, null],
      ["created", null, null],
    ]);

    // Même type et même id : remplacé, rattachement refait.
    const again = ((await (await s.bot(key, { items: [{ type: "satisfaction", id: "tg-1", event: "Gemona", date: "2026-07-28", score: 2 }] })).json()) as Resp).items[0]!;
    expect([again.status, again.task]).toEqual(["updated", 3]);
    expect((s.db.prepare("SELECT COUNT(*) n FROM task_reports").get() as { n: number }).n).toBe(6);

    // Page de la manche : réservée à l'organisateur, contenu échappé.
    const edit = await (await s.req(`${t3.url}/edit`)).text();
    expect(edit).toContain("Retours des pilotes et incidents (2)");
    expect(edit).toContain("inc-1");
    expect(edit).not.toContain("<b>manche</b>");
    const pub = await (await s.req(t3.url, { headers: { cookie: "" } })).text();
    expect(pub).not.toContain("inc-1");

    // Une manche créée plus tard récupère ce qui l'attendait.
    await task(s.req, gemona, 5, "2026-07-30");
    const row = s.db.prepare("SELECT t.number FROM task_reports r JOIN tasks t ON t.id = r.task_id WHERE r.external_id = 'tg-2'").get() as { number: number };
    expect(row.number).toBe(5);

    // Rattachement à la main, gardé quand l'élément revient.
    const pending = await (await s.req("/admin/ingest")).text();
    expect(pending).toContain("Open de Kastania");
    const id4 = (s.db.prepare("SELECT id FROM task_reports WHERE external_id = 'tg-4'").get() as { id: number }).id;
    expect((await s.req(`/admin/ingest/reports/${id4}`, { method: "POST", body: new URLSearchParams({ competition: String(compId), task: "3" }) })).status).toBe(302);
    await s.bot(key, { type: "satisfaction", id: "tg-4", event: "Open de Kastania", date: "2026-07-28", score: 5 });
    expect(s.db.prepare("SELECT task_id, matched FROM task_reports WHERE id = ?").get(id4)).toEqual({ task_id: t3.id, matched: "manual" });
    expect((await s.req(`/admin/ingest/reports/${id4}`, { method: "POST", body: new URLSearchParams({ competition: String(compId), task: "9" }) })).status).toBe(400);
  });

  it("rejette les envois mal formés", async () => {
    const s = setup();
    const key = await adminKey(s);
    expect((await s.bot(key, undefined, "{pas du json")).status).toBe(400);
    expect((await s.bot(key, [1, 2])).status).toBe(400);
    expect((await s.bot(key, [])).status).toBe(400);
    expect((await s.bot(key, { type: { x: 1 } })).status).toBe(400);
    expect((await s.bot(key, { text: "x".repeat(1024 * 1024 + 10) })).status).toBe(413);
  });
});

