import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type CompetitionRow } from "../src/db.js";
import { TrackStore } from "../src/track-store.js";
import { competitionFsdb, fsdbToArchive, looksLikeFsdb } from "../src/fsdb.js";
import { listPilots } from "../src/pilots.js";
import { listRankings } from "../src/rankings.js";
import { parseXml, child, children } from "../src/xml.js";

const FSDB = readFileSync(new URL("fixtures/competition.fsdb", import.meta.url));
const IGC = Buffer.from("AXCT test\r\nHFDTE150826\r\nB1200004612345N01308765EA0150001600\r\n");

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
  return { db, req, login };
}

describe("échange avec FS (FSDB)", () => {
  it("importe un .fsdb par l'API : compétition, formule, pilotes, manche, catégories et pénalités", async () => {
    const { db, req, login } = setup();
    await login("orga@example.org");
    const page = await (await req("/account/tokens", { method: "POST", body: new URLSearchParams({ name: "script" }) })).text();
    const key = /pgs_[A-Za-z0-9_-]+/.exec(page)![0];
    const im = await req("/api/competitions/import", {
      method: "POST",
      body: FSDB,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/xml" },
    });
    expect(im.status).toBe(201);
    const r = (await im.json()) as { id: number; tasks: number; pilots: number; tracks: number; warnings?: string[] };
    expect(r).toMatchObject({ tasks: 1, pilots: 2, tracks: 0 });
    // Un .fsdb seul ne contient pas les traces : on le dit.
    expect(r.warnings!.join(" ")).toContain("FSDB seul");

    const comp = db.prepare("SELECT * FROM competitions WHERE id = ?").get(r.id) as unknown as CompetitionRow;
    expect(comp.name).toBe("Coupe de test FS");
    const settings = JSON.parse(comp.params) as Record<string, unknown>;
    expect(settings).toMatchObject({ nominalDistance: 40000, minimumDistance: 7000, nominalTime: 3600, ftvFactor: 0.25, timeZone: "Etc/GMT-2" });

    const pilots = listPilots(db, r.id);
    const ana = pilots.find((p) => p.pilot_key === "12")!;
    expect(ana).toMatchObject({ name: "Ana Essai", nation: "FRA", gender: "F", glider_brand: "Ozone", glider_model: "Enzo 3", glider_class: "CCC", sponsor: "Air3", civl_id: "99001" });
    expect(pilots.find((p) => p.pilot_key === "7")!).toMatchObject({ glider_class: "EN-D", glider_brand: "Gin", glider_model: "Boomerang 12", harness_brand: null });

    // Manche : balises dans l'ordre, rôles déduits de ss/es, heures converties en UTC.
    const task = JSON.parse((db.prepare("SELECT task FROM tasks WHERE competition_id = ?").get(r.id) as { task: string }).task);
    expect(task.type).toBe("race");
    expect(task.turnpoints.map((x: { role: string }) => x.role)).toEqual(["takeoff", "sss", "turnpoint", "ess", "goal"]);
    expect(task.startGates).toEqual(["11:30:00"]);
    expect(task.takeoffOpen).toBe("09:00:00");
    expect(task.deadline).toBe("16:00:00");
    expect(task.turnpoints[4].zone).toMatchObject({ kind: "cylinder", radius: 200 });
    expect(task.turnpoints[1].zone.waypoint).toMatchObject({ name: "B02", lat: 46.2, lon: 13.1 });
    expect(task.pilotsPresent).toBe(2);
    expect(task.leadingTimeRatio).toBe(0.18);

    // Catégories : celle qui s'exprime en règle devient une règle, l'autre une liste de pilotes.
    const rankings = listRankings(db, r.id);
    expect(rankings.map((x) => x.row.name)).toEqual(["Femme", "Serial"]);
    expect(rankings[0]!.rule.conditions).toEqual([{ field: "gender", op: "in", value: "F" }]);
    expect([...rankings[1]!.overrides.keys()]).toEqual(["12"]);

    // Pénalités saisies dans FS : reprises en décisions (5 % et 10 points).
    const decisions = db.prepare("SELECT pilot_key, kind, value FROM task_decisions ORDER BY kind").all() as Array<{ pilot_key: string; kind: string; value: number }>;
    expect(decisions).toEqual([
      { pilot_key: "7", kind: "penalty", value: 10 },
      { pilot_key: "7", kind: "penalty-percent", value: 5 },
    ]);

    // Export FSDB : relu par notre propre lecteur, et servi par l'API.
    const out = competitionFsdb(db, comp);
    const fs = child(parseXml(out), "Fs")!;
    const fsComp = child(fs, "FsCompetition")!;
    expect(fsComp.attrs.name).toBe("Coupe de test FS");
    expect(children(child(fsComp, "FsParticipants"), "FsParticipant")).toHaveLength(2);
    const again = fsdbToArchive(new Uint8Array(Buffer.from(out, "utf8")));
    expect(again.a.pilots).toHaveLength(2);
    expect(again.a.tasks[0]!.decisions).toHaveLength(2);
    expect(again.a.tasks[0]!.task.startGates).toEqual(["11:30:00"]);
    const dl = await req(`/api/competitions/${r.id}/fsdb`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("coupe-de-test-fs.fsdb");
    expect((await dl.text()).startsWith("<?xml")).toBe(true);
  });

  it("importe un ZIP FS avec ses dossiers de traces", async () => {
    const { req, login } = setup();
    await login("orga@example.org");
    const zip = zipSync({ "Coupe.fsdb": new Uint8Array(FSDB), "tracks/T01/12.igc": new Uint8Array(IGC), "notes.txt": strToU8("ignoré") });
    expect(looksLikeFsdb(zip)).toBe(true);
    const f = new FormData();
    f.append("file", new Blob([zip as BlobPart]), "coupe.zip");
    const res = await req("/competitions/import", { method: "POST", body: f });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(decodeURIComponent(loc)).toContain("1 traces");
    const id = Number(loc.split("/")[2]!.split("?")[0]);
    const ex = unzipSync(new Uint8Array(await (await req(`/api/competitions/${id}/fsdb.zip`)).arrayBuffer()));
    expect(Object.keys(ex).sort()).toEqual(["coupe-de-test-fs.fsdb", "tracks/T01/12.igc"]);
    expect(Buffer.compare(Buffer.from(ex["tracks/T01/12.igc"]!), IGC)).toBe(0);
    expect(strFromU8(ex["coupe-de-test-fs.fsdb"]!)).toContain('tracklog_filename="12.igc"');
  });

  it("distingue une archive pgscore d'un FSDB", () => {
    expect(looksLikeFsdb(new Uint8Array(FSDB))).toBe(true);
    expect(looksLikeFsdb(zipSync({ "competition.json": strToU8("{}"), "x.fsdb": strToU8("<Fs/>") }))).toBe(false);
    expect(looksLikeFsdb(strToU8("numero,nom\n1,A\n"))).toBe(false);
  });
});
