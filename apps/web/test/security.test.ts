import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { TrackStore } from "../src/track-store.js";

const tracks = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-sec-")));
const app = createApp(openDb(":memory:", tracks), tracks, { baseUrl: "http://localhost", devLogin: true });

/** Corps envoyé par morceaux, sans Content-Length. */
const chunked = (bytes: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let sent = 0; sent < bytes; sent += 1024 * 1024) c.enqueue(new Uint8Array(Math.min(1024 * 1024, bytes - sent)));
      c.close();
    },
  });

describe("sécurité des réponses et des envois", () => {
  it("envoie la politique de sécurité et les en-têtes associés", async () => {
    const r = await app.request("http://localhost/login");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    // Plus aucun gestionnaire d'événement en ligne, que script-src 'self' bloquerait.
    expect(await r.text()).not.toMatch(/\son(click|submit|change|load)=/);
  });

  it("refuse un formulaire trop gros envoyé sans Content-Length", async () => {
    const r = await app.request("http://localhost/auth/dev", {
      method: "POST",
      body: chunked(21 * 1024 * 1024),
      headers: { "content-type": "application/x-www-form-urlencoded", "transfer-encoding": "chunked" },
      // @ts-expect-error option de fetch de Node pour un corps en flux
      duplex: "half",
    });
    expect(r.status).toBe(413);
  });

  it("laisse passer un petit formulaire", async () => {
    const r = await app.request("http://localhost/auth/dev", { method: "POST", body: new URLSearchParams({ email: "a@example.org" }) });
    expect(r.status).toBe(302);
  });
});
