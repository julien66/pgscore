import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { learnFilenameConvention, pilotKeyForTrack } from "../src/files.js";
import { TrackStore } from "../src/track-store.js";

const QR = readFileSync(new URL("../../../packages/engine/test/fixtures/pwca-gemona-2026-t3.qr.txt", import.meta.url), "utf8").trim();
const igc = (header: string, n = 0) => `AXCT test\r\nHFDTE280726\r\n${header}\r\nB12000${n}4612345N01308765EA0150001600\r\n`;

describe("pilote d'une trace envoyée", () => {
  it("noms longs IGC : le numéro du vol du jour n'identifie pas le pilote", () => {
    const used = new Map<string, string | null>();
    const keys = [
      pilotKeyForTrack("2026-05-29-XSD-UB5380-01.igc", igc("HFPLTPILOTINCHARGE:Hans Petit\r\nHFCIDCOMPETITIONID:NKN"), [], used),
      pilotKeyForTrack("2026-05-29-XSD-UBF26C-01.igc", igc("HFPLTPILOTINCHARGE:"), [], used),
      pilotKeyForTrack("2026-05-29-XTR-ED1831420028-01.IGC", igc("HFPLTPILOTINCHARGE:"), [], used),
      pilotKeyForTrack("2026-05-29-XCT-XXX-01 1.igc", igc("HFPLTPILOTINCHARGE:"), [], used),
      pilotKeyForTrack("2026-05-29-XCT-XXX-01 2.igc", igc("HFPLTPILOTINCHARGE:"), [], used),
    ];
    expect(keys).toEqual(["hans-petit", "XSD-UBF26C", "XTR-ED1831420028", "XCT-XXX", "XCT-XXX-2"]);
  });

  it("retrouve l'inscrit par le numéro du fichier, le HFCID ou le nom de l'en-tête", () => {
    const reg = [
      { pilot_key: "12", name: "HUBERT François" },
      { pilot_key: "7", name: "Ana Essai" },
    ];
    expect(pilotKeyForTrack("12.igc", igc("HFPLTPILOTINCHARGE:"), reg)).toBe("12");
    expect(pilotKeyForTrack("alt_1.7.igc", igc("HFPLTPILOTINCHARGE:Ana Essai"), reg)).toBe("7");
    // Trace de secours PWCA sans inscrits : le numéro du fichier, pas le nom de l'en-tête.
    expect(pilotKeyForTrack("alt_1.710.igc", igc("HFPLTPILOTINCHARGE:Érico Oliveira"), [])).toBe("710");
    expect(pilotKeyForTrack("2026-05-29-XCT-ABC-01.igc", igc("HFCIDCOMPETITIONID:7"), reg)).toBe("7");
    expect(pilotKeyForTrack("2026-05-29-XSD-UBFC6C-01.igc", igc("HFPLTPILOTINCHARGE:François HUBERT\r\nHFCIDCOMPETITIONID:67717"), reg)).toBe("12");
  });

  it("à l'envoi, des traces anonymes ne s'écrasent pas, même d'un envoi à l'autre", async () => {
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
    await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "o@example.org", name: "o" }) });
    const f = new FormData();
    for (const [k, v] of Object.entries({ name: "Entraînement", location: "Gemona", start_date: "2026-07-28", end_date: "2026-07-28", nominalDistance: "60", minimumDistance: "5", nominalTime: "60", ftvFactor: "25", gapProfile: "PWCA", airspacePenaltyRule: "pwca-soft", timeZone: "Europe/Rome" })) f.append(k, v);
    const compUrl = (await req("/competitions", { method: "POST", body: f })).headers.get("location")!;
    const ft = new FormData();
    ft.append("number", "1");
    ft.append("date", "2026-07-28");
    ft.append("text", QR);
    const taskUrl = (await req(`${compUrl}/tasks`, { method: "POST", body: ft })).headers.get("location")!.split("?")[0]!;
    const taskId = Number(taskUrl.split("/").pop());
    const send = async (files: Array<[string, string]>) => {
      const up = new FormData();
      for (const [name, text] of files) up.append("files", new Blob([text]), name);
      return (await req(`${taskUrl}/tracks`, { method: "POST", body: up })).headers.get("location")!;
    };
    const anon = [
      ["2026-05-29-XSD-UB5380-01.igc", igc("HFPLTPILOTINCHARGE:Hans Petit", 1)],
      ["2026-05-29-XSD-UBF26C-01.igc", igc("HFPLTPILOTINCHARGE:Damien S", 2)],
      ["2026-05-29-XTR-ED1831420028-01.IGC", igc("HFPLTPILOTINCHARGE:", 3)],
      ["2026-05-29-XCT-XXX-01.igc", igc("HFPLTPILOTINCHARGE:", 4)],
    ] as Array<[string, string]>;
    expect(await send(anon)).toContain("added=4");
    // Même envoi refait : rien ne change. Nouvelle trace anonyme du même instrument : ajoutée à part.
    expect(await send(anon)).toContain("same=");
    expect(await send([["2026-05-29-XCT-XXX-01.igc", igc("HFPLTPILOTINCHARGE:", 5)]])).toContain("added=1");
    const keys = (db.prepare("SELECT pilot_key FROM tracks WHERE task_id = ? ORDER BY id").all(taskId) as Array<{ pilot_key: string }>).map((r) => r.pilot_key);
    expect(keys).toEqual(["hans-petit", "damien-s", "XTR-ED1831420028", "XCT-XXX", "XCT-XXX-2"]);
    // Retirer une trace : retour sur la page avec la liste des traces toujours dépliée.
    const trackId = (db.prepare("SELECT id FROM tracks WHERE task_id = ? LIMIT 1").get(taskId) as { id: number }).id;
    const del = await req(`${taskUrl}/tracks/${trackId}/delete`, { method: "POST" });
    expect(del.headers.get("location")).toContain("open=tracks");
    const page = await (await req(del.headers.get("location")!)).text();
    expect(page).toMatch(/<details class="mt" open="">\s*<summary>Voir les traces/);
  });
});

describe("numéro du pilote : en-tête d'abord, puis convention de nommage du lot", () => {
  // En-tête d'une trace Flymaster comme celles de l'US Open Chelan 2026 (« albert_nazander_2026-06-21_01.24.igc »).
  const fm = (pilot: string, cid = "", n = 0) =>
    `AXFMSFP Flymaster Live, V1.0\r\nHFPLTPILOT:${pilot}\r\nHFCIDCOMPETITIONID:${cid}\r\nHFDTE210626\r\nB19164${n}4748232N12002329WA0109001128\r\n`;
  const batch = (files: Array<[string, string]>, reg: Array<{ pilot_key: string; name: string }>) => {
    const conv = learnFilenameConvention(files.map(([filename, text]) => ({ filename, text })), reg);
    const used = new Map<string, string | null>();
    return files.map(([f, text]) => pilotKeyForTrack(f, text, reg, used, conv));
  };

  it("HFCID de l'en-tête avant le nom et le numéro du fichier", () => {
    expect(batch([["albert_nazander_2026-06-21_01.24.igc", fm("Albert Nazander", "24")]], [])).toEqual(["24"]);
    const reg = [
      { pilot_key: "12", name: "Jean Douze" },
      { pilot_key: "7", name: "Ana Essai" },
    ];
    expect(pilotKeyForTrack("12.igc", igc("HFCIDCOMPETITIONID:7"), reg)).toBe("7");
    // Instrument prêté : nom de l'en-tête et numéro du fichier désignent ensemble l'autre inscrit.
    expect(pilotKeyForTrack("12.igc", igc("HFPLTPILOTINCHARGE:Jean Douze\r\nHFCIDCOMPETITIONID:7"), reg)).toBe("12");
  });

  it("traces sans HFCID : la place du numéro est apprise sur celles qui en ont un", () => {
    const keys = batch(
      [
        ["albert_nazander_2026-06-21_01.24.igc", fm("Albert Nazander", "24", 1)],
        ["bea_martin_2026-06-21_01.131.igc", fm("Bea Martin", "131", 2)],
        ["carl_olsen_2026-06-21_02.7.igc", fm("", "", 3)],
        ["dora_kent_2026-06-21_01.56.igc", fm("Dora Kent", "", 4)],
      ],
      [],
    );
    expect(keys).toEqual(["24", "131", "7", "56"]);
  });

  it("heures dans le nom de fichier : pas prises pour des numéros, le nom du fichier retrouve l'inscrit", () => {
    const reg = [
      { pilot_key: "101", name: "NAZANDER Albert" },
      { pilot_key: "102", name: "SMITH Bob" },
      { pilot_key: "103", name: "ROSSI Carla" },
      { pilot_key: "24", name: "OTHER Dan" },
    ];
    const keys = batch(
      [
        ["albert_nazander_2026-06-21_13.24.igc", fm("", "", 1)],
        ["bob_smith_2026-06-21_13.07.igc", fm("", "", 2)],
        ["carla_rossi_2026-06-21_14.24.igc", fm("", "", 3)],
      ],
      reg,
    );
    expect(keys).toEqual(["101", "102", "103"]);
  });

  it("date seule dans le nom : aucun numéro, le nom du pilote", () => {
    const conv = learnFilenameConvention([{ filename: "albert_nazander_2026-06-21.igc", text: fm("Albert Nazander") }], []);
    expect(conv.slot).toBeNull();
    expect(pilotKeyForTrack("albert_nazander_2026-06-21.igc", fm("Albert Nazander"), [], new Map(), conv)).toBe("albert-nazander");
  });

  it("archive FS (« LiveTrack Nom..date-heure.civl.numéro ») : le dernier nombre, confirmé par les inscrits", () => {
    const reg = [
      { pilot_key: "58008", name: "HÄGER Andreas" },
      { pilot_key: "60", name: "RAISSON Adrien" },
      { pilot_key: "4", name: "DUBOIS-MERCE Antoine" },
      { pilot_key: "12", name: "BOUVARD Téo" },
    ];
    const keys = batch(
      [
        ["LiveTrack Andreas H#U00e4ger..20260614-092611.82848.58008.igc", igc("HFPLTPILOTINCHARGE:", 1)],
        ["LiveTrack Adrien Raisson..20260614-084424.60845.60.igc", igc("HFPLTPILOTINCHARGE:", 2)],
        ["LiveTrack Antoine Dubois-Merce..20260614-084809.75810.4.igc", igc("HFPLTPILOTINCHARGE:", 3)],
        // Accent perdu dans le nom du fichier, numéro absent : retrouvé par le nom.
        ["T_o_Bouvard.igc", igc("HFPLTPILOTINCHARGE:", 4)],
      ],
      reg,
    );
    expect(keys).toEqual(["58008", "60", "4", "12"]);
  });
});
