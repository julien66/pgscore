import { existsSync, readFileSync, readdirSync } from "node:fs";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";

const engineFixtures = new URL("../../../packages/engine/test/fixtures/", import.meta.url);
const QR = readFileSync(new URL("pwca-gemona-2026-t3.qr.txt", engineFixtures), "utf8").trim();
const AIRSPACE = readFileSync(new URL("pwca-gemona-2026-airspace.txt", engineFixtures));

function setup() {
  const db = openDb(":memory:");
  const app = createApp(db, { baseUrl: "http://localhost", devLogin: true });
  let cookie = "";
  const req = async (path: string, init: RequestInit = {}) => {
    const r = await app.request(`http://localhost${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return r;
  };
  return { db, req };
}

const competitionFields = {
  name: "Coupe test",
  location: "Gemona",
  start_date: "2026-07-25",
  end_date: "2026-08-01",
  nominalDistance: "60",
  minimumDistance: "5",
  nominalTime: "60",
  ftvFactor: "0",
  leadingProfile: "PWCA",
  airspacePenaltyRule: "pwca-soft",
  timeZone: "Europe/Rome",
  roundAirspaceLimits: "on",
};

async function createCompetitionAndTask(req: ReturnType<typeof setup>["req"]) {
  await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "orga@example.org", name: "Orga" }) });
  const f = new FormData();
  for (const [k, v] of Object.entries(competitionFields)) f.append(k, v);
  f.append("airspace", new Blob([AIRSPACE]), "gemona.txt");
  const rc = await req("/competitions", { method: "POST", body: f });
  expect(rc.status).toBe(302);
  const compUrl = rc.headers.get("location")!;
  const ft = new FormData();
  ft.append("number", "3");
  ft.append("date", "2026-07-28");
  ft.append("text", QR);
  const rt = await req(`${compUrl}/tasks`, { method: "POST", body: ft });
  expect(rt.status).toBe(302);
  return { compUrl, taskUrl: rt.headers.get("location")! };
}

describe("interface web", () => {
  it("demande de se connecter", async () => {
    const { req } = setup();
    const r = await req("/");
    expect(await r.text()).toContain("Connexion de développement");
  });

  it("crée une compétition avec son espace aérien, puis une manche depuis le texte du QR code", async () => {
    const { req } = setup();
    const { compUrl, taskUrl } = await createCompetitionAndTask(req);
    const comp = await (await req(compUrl)).text();
    expect(comp).toContain("Coupe test");
    expect(comp).toContain("15 zones");
    const task = await (await req(taskUrl)).text();
    expect(task).toContain("84,05 km");
    expect(task).toContain("13:25:00"); // porte 11:25Z affichée en heure de Gemona
  });

  it("enregistre l'heure d'arrêt saisie en heure locale", async () => {
    const { req, db } = setup();
    const { taskUrl } = await createCompetitionAndTask(req);
    await req(taskUrl, { method: "POST", body: new URLSearchParams({ date: "2026-07-28", stop: "15:47" }) });
    const row = db.prepare("SELECT task FROM tasks").get() as { task: string };
    expect(JSON.parse(row.task).stopAnnouncement).toBe("13:47:00");
  });

  it("refuse une manche illisible et l'accès aux compétitions des autres", async () => {
    const { req } = setup();
    const { compUrl } = await createCompetitionAndTask(req);
    const ft = new FormData();
    ft.append("number", "4");
    ft.append("text", "XCTSK:{pas du json");
    const r = await req(`${compUrl}/tasks`, { method: "POST", body: ft });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Manche illisible");
    await req("/auth/logout", { method: "POST" });
    await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "autre@example.org" }) });
    expect((await req(compUrl)).status).toBe(404);
  });

  it("lit l'image du QR code", async () => {
    const png = "/mnt/project-files/jeux-de-test/pwca-gemona-2026/manche-3/task3_qr_code.png";
    if (!existsSync(png)) return;
    const { req } = setup();
    const { compUrl } = await createCompetitionAndTask(req);
    const ft = new FormData();
    ft.append("number", "5");
    ft.append("qr", new Blob([readFileSync(png)]), "qr.png");
    const r = await req(`${compUrl}/tasks`, { method: "POST", body: ft });
    expect(r.status).toBe(302);
  });

  const dir = process.env.GEMONA_T3_IGC_DIR;
  it.skipIf(!dir || !existsSync(dir))("calcule la manche à partir d'un zip de traces", { timeout: 120_000 }, async () => {
    const { req } = setup();
    const { taskUrl } = await createCompetitionAndTask(req);
    const pick = ["2.igc", "260.igc", "269.igc", "alt_1.775.igc"];
    const zip = zipSync(Object.fromEntries(readdirSync(dir!).filter((f) => pick.includes(f)).map((f) => [f, readFileSync(`${dir}/${f}`)])));
    const fu = new FormData();
    fu.append("files", new Blob([zip]), "T3.zip");
    const ru = await req(`${taskUrl}/tracks`, { method: "POST", body: fu });
    expect(ru.headers.get("location")).toContain("added=4");
    await req(`${taskUrl}/runs`, { method: "POST" });
    let html = "";
    for (let i = 0; i < 100; i++) {
      html = await (await req(taskUrl)).text();
      if (!html.includes("Calcul en cours")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(html).toContain("Baptiste Lambert");
    expect(html).toContain("RISERVA CORNINO");
    expect(html).toContain("MIND");
    const csv = await (await req(`${taskUrl}/results.csv`)).text();
    expect(csv.split("\n")[1]).toContain("GOAL");
  });
});
