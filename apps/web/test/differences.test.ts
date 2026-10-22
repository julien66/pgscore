import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GAP_RULES } from "@pgscore/engine";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { COMMON, DIFFERENCES, UNIT_TEST_FILE } from "../src/differences.js";
import { controlTask, PWCA_CYLINDER_TOLERANCE } from "../src/settings.js";
import { TrackStore } from "../src/track-store.js";

const ROOT = new URL("../../../", import.meta.url).pathname;

describe("page des différences CIVL / PWCA", () => {
  const all = [...DIFFERENCES, COMMON];

  it("chaque test unitaire cité existe, et chaque fichier de preuve aussi", () => {
    const src = readFileSync(join(ROOT, UNIT_TEST_FILE), "utf8");
    const titles = new Set([...src.matchAll(/\bit\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string));
    for (const d of all) {
      expect(d.unitTests.length, d.id).toBeGreaterThan(0);
      for (const u of d.unitTests) {
        expect(titles.has(u), `${d.id} : « ${u} »`).toBe(true);
        expect(u.startsWith(`${d.id} `), u).toBe(true);
      }
      for (const p of d.proofs) expect(existsSync(join(ROOT, p.file)), p.file).toBe(true);
    }
  });

  it("la tolérance de 0,1 % (D1) est bien celle que le profil PWCA applique", () => {
    expect(PWCA_CYLINDER_TOLERANCE).toBe(0.001);
    expect(controlTask({} as { cylinderTolerance?: number }, { gapProfile: "PWCA" }).cylinderTolerance).toBe(0.001);
    expect(controlTask({} as { cylinderTolerance?: number }, { gapProfile: "S7F2026" }).cylinderTolerance).toBeUndefined();
    expect(GAP_RULES.PWCA.leadingShortestSpeedSection).toBe(true);
    expect(GAP_RULES.S7F2026.leadingShortestSpeedSection).toBe(false);
  });

  it("s'affiche sans compte, avec chaque différence et le lien vers le test", async () => {
    const tracks = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-tracks-")));
    const app = createApp(openDb(":memory:", tracks), tracks, { baseUrl: "http://localhost", devLogin: true, adminEmails: [] });
    const r = await app.request("http://localhost/differences");
    expect(r.status).toBe(200);
    const html = await r.text();
    for (const d of all) expect(html).toContain(`id="${d.id}"`);
    expect(html).toContain(`blob/main/${UNIT_TEST_FILE}`);
    const en = await (await app.request("http://localhost/differences", { headers: { cookie: "lang=en" } })).text();
    expect(en).toContain("Cylinder tolerance");
    const home = await (await app.request("http://localhost/")).text();
    expect(home).toContain('href="/differences"');
  });
});
