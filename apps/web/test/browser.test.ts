import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { TrackStore } from "../src/track-store.js";

/**
 * Pages de l'appli dans un vrai navigateur (Chromium, Playwright) : aucune erreur JavaScript ni
 * violation de la politique de sécurité, suivi du calcul sans recharger la page, visionneuse.
 * La compétition a des pilotes inscrits, ce qui ajoute les formulaires « Rattacher » à la page de la
 * manche (ils faisaient planter run.js).
 */
const fixtures = new URL("../../../packages/engine/test/fixtures/", import.meta.url);
const QR = readFileSync(new URL("us-open-chelan-2026-t1.qr.txt", fixtures), "utf8").trim();
const IGC = readFileSync(new URL("us-open-chelan-2026-t1-24.igc", fixtures));

let server: ServerType;
let browser: Browser;
let base = "";
let taskUrl = "";
const problems: string[] = [];

/** Page connectée, qui note toute erreur JavaScript, toute violation de CSP et toute ressource manquante. */
async function page(): Promise<Page> {
  const p = await browser.newPage();
  await p.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`)),
  );
  p.on("pageerror", (e) => problems.push(`${p.url()} : ${e.message}`));
  p.on("console", (m) => m.type() === "error" && problems.push(`${p.url()} : ${m.text()}`));
  await p.goto(`${base}/login`);
  await p.fill("input[name=email]", "orga@example.org");
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login")), p.click("form[action='/auth/dev'] button")]);
  return p;
}

beforeAll(async () => {
  const tracks = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-browser-")));
  const app = createApp(openDb(":memory:", tracks), tracks, { baseUrl: "http://localhost", devLogin: true });
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((res) => server.once("listening", res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();

  // Compétition, manche, pilotes inscrits et une trace, par les formulaires de l'appli.
  let cookie = "";
  const req = async (path: string, body: FormData | URLSearchParams) => {
    const r = await fetch(`${base}${path}`, { method: "POST", body, headers: { cookie }, redirect: "manual" });
    cookie = r.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return r.headers.get("location") ?? "";
  };
  await req("/auth/dev", new URLSearchParams({ email: "orga@example.org", name: "Orga" }));
  const comp = await req(
    "/competitions",
    new URLSearchParams({
      name: "Chelan",
      location: "Chelan",
      start_date: "2026-06-20",
      end_date: "2026-06-27",
      nominalDistance: "60",
      minimumDistance: "5",
      nominalTime: "60",
      ftvFactor: "0",
      airspacePenaltyRule: "pwca-soft",
      timeZone: "America/Los_Angeles",
    }),
  );
  const task = new FormData();
  task.append("number", "1");
  task.append("text", QR);
  taskUrl = (await req(`${comp}/tasks`, task)).split("?")[0]!;
  const pilots = new FormData();
  pilots.append("file", new Blob(["numero,nom\n24,Pilote Essai\n25,Autre Pilote\n"]), "pilotes.csv");
  await req(`${comp}/pilots/import`, pilots);
  const up = new FormData();
  up.append("files", new Blob([IGC]), "trace.igc");
  await req(`${taskUrl}/tracks`, up);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe("dans le navigateur", () => {
  it("lance le calcul et montre le classement sans recharger la page", async () => {
    const p = await page();
    await p.goto(`${base}${taskUrl}/edit`);
    expect(await p.locator("form[action$='/pilot']").count()).toBeGreaterThan(0);
    let reloaded = false;
    p.on("framenavigated", (f) => f === p.mainFrame() && (reloaded = true));
    await p.click("#run-form button");
    await p.locator("#run-card table").waitFor({ timeout: 30_000 });
    expect(await p.locator("#run-card").innerText()).toContain("Pilote Essai");
    expect(reloaded).toBe(false);
    await p.close();
  }, 60_000);

  it("ouvre la visionneuse d'une trace avec sa carte et son contrôle", async () => {
    const p = await page();
    await p.goto(`${base}${taskUrl}/pilots/24`);
    await p.locator(".leaflet-container").waitFor();
    expect(await p.locator("body").innerText()).toContain("Pilote Essai");
    await p.close();
  }, 60_000);

  it("ne relève aucune erreur sur les pages parcourues", async () => {
    const p = await page();
    const comp = taskUrl ? (await (await fetch(`${base}${taskUrl}`)).text()).match(/href="(\/competitions\/\d+)"/)?.[1] : null;
    for (const u of ["/", comp, `${comp}/edit`, `${comp}/standings`, taskUrl, "/account", "/api"]) {
      if (u) await p.goto(`${base}${u}`, { waitUntil: "load" });
    }
    await p.close();
    // Fonds de carte : pas d'accès à Internet dans les tests, leurs erreurs de chargement ne comptent pas.
    expect(problems.filter((x) => !/Failed to load resource: net::/.test(x))).toEqual([]);
  }, 60_000);
});
