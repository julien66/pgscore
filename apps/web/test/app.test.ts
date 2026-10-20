import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { TrackStore } from "../src/track-store.js";

const engineFixtures = new URL("../../../packages/engine/test/fixtures/", import.meta.url);
const QR = readFileSync(new URL("pwca-gemona-2026-t3.qr.txt", engineFixtures), "utf8").trim();
const AIRSPACE = readFileSync(new URL("pwca-gemona-2026-airspace.txt", engineFixtures));

function setup(adminEmails: string[] = []) {
  const tracks = new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-tracks-")));
  const db = openDb(":memory:", tracks);
  const app = createApp(db, tracks, { baseUrl: "http://localhost", devLogin: true, adminEmails });
  let cookie = "";
  const req = async (path: string, init: RequestInit = {}) => {
    const r = await app.request(`http://localhost${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return r;
  };
  return { db, tracks, req };
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
  return { compUrl, taskUrl: rt.headers.get("location")!.split("?")[0]! };
}

describe("interface web", () => {
  it("ouvre l'accueil sans compte et demande de se connecter pour modifier", async () => {
    const { req } = setup();
    const home = await (await req("/")).text();
    expect(home).toContain("Compétitions récemment calculées");
    expect(home).toContain('href="/login"');
    expect(await (await req("/login")).text()).toContain("Connexion de développement");
    expect((await req("/competitions/new")).headers.get("location")).toBe("/login");
    expect((await req("/competitions", { method: "POST", body: new URLSearchParams(competitionFields) })).headers.get("location")).toBe("/login");
  });

  it("crée une compétition avec son espace aérien, puis une manche depuis le texte du QR code", async () => {
    const { req } = setup();
    const { compUrl, taskUrl } = await createCompetitionAndTask(req);
    const comp = await (await req(compUrl)).text();
    expect(comp).toContain("Coupe test");
    expect(await (await req(`${compUrl}/edit`)).text()).toContain("15 zones");
    const task = await (await req(taskUrl)).text();
    expect(task).toContain("84,05 km");
    expect(task).toContain("13:25:00"); // porte 11:25Z affichée en heure de Gemona
    // Dessin de la manche pour la carte : une zone par balise, une branche de moins.
    const geo = JSON.parse(/<script type="application\/json" id="task-geometry">(.*?)<\/script>/s.exec(task)![1]!);
    expect(geo.legs).toHaveLength(geo.route.length - 1);
    expect(geo.zones.length).toBe(geo.route.length);
    expect((await (await req(`${taskUrl}/run.json`)).json()).status).toBe("none");
  });

  it("enregistre l'heure d'arrêt saisie en heure locale", async () => {
    const { req, db } = setup();
    const { taskUrl } = await createCompetitionAndTask(req);
    await req(taskUrl, { method: "POST", body: new URLSearchParams({ date: "2026-07-28", stop: "15:47" }) });
    const row = db.prepare("SELECT task FROM tasks").get() as { task: string };
    expect(JSON.parse(row.task).stopAnnouncement).toBe("13:47:00");
  });

  it("enregistre et supprime les décisions de l'organisateur", async () => {
    const { req, db } = setup();
    const { taskUrl } = await createCompetitionAndTask(req);
    const post = (f: Record<string, string>) => req(`${taskUrl}/decisions`, { method: "POST", body: new URLSearchParams(f) });
    expect((await post({ pilot: "613", kind: "bonus", value: "799", reason: "" })).status).toBe(400);
    expect((await post({ pilot: "613", kind: "bonus", value: "", reason: "Aide" })).status).toBe(400);
    expect((await post({ pilot: "613", kind: "bonus", value: "799", reason: "Aide à un pilote accidenté" })).status).toBe(302);
    expect((await post({ pilot: "999", name: "Resté au sol", kind: "dnf", reason: "Conditions" })).status).toBe(302);
    const html = await (await req(`${taskUrl}/edit`)).text();
    expect(html).toContain("Bonus 799 pts");
    expect(html).toContain("Aide à un pilote accidenté");
    expect(html).toContain("Resté au sol");
    const rows = db.prepare("SELECT id, kind, value FROM task_decisions ORDER BY id").all() as Array<{ id: number; kind: string; value: number | null }>;
    expect(rows.map((r) => [r.kind, r.value])).toEqual([["bonus", 799], ["dnf", null]]);
    expect((db.prepare("SELECT scoring_changed_at FROM tasks").get() as { scoring_changed_at: number }).scoring_changed_at).toBeGreaterThan(0);
    await req(`${taskUrl}/decisions/${rows[0]!.id}/delete`, { method: "POST" });
    expect((await (await req(`${taskUrl}/edit`)).text()).includes("Bonus 799 pts")).toBe(false);
  });

  it("classe la compétition avec les manches officielles", async () => {
    const { req, db } = setup();
    const { compUrl, taskUrl } = await createCompetitionAndTask(req);
    const taskId = Number(taskUrl.split("/").pop());
    // Résultats déjà calculés (sans traces) : seuls les totaux et la validité servent au classement.
    const results = {
      pilots: [
        { id: "12", name: "Ana Vainqueur", total: 1000 },
        { id: "7", name: "Bruno Second", total: 640.5 },
      ],
      gap: { validity: { task: 1 }, available: { distance: 400, time: 350, leading: 250, arrival: 0 } },
    };
    db.prepare("INSERT INTO runs (task_id, status, results, started_at, finished_at) VALUES (?, 'done', ?, ?, ?)").run(
      taskId,
      JSON.stringify(results),
      Date.now() + 1000,
      Date.now() + 2000,
    );
    let comp = await (await req(compUrl)).text();
    expect(comp).toContain("Classements");
    expect(comp).toContain("Aucune manche officielle calculée");
    expect((await req(`${taskUrl}/official`, { method: "POST", body: new URLSearchParams({ official: "1" }) })).status).toBe(302);
    comp = await (await req(compUrl)).text();
    expect(comp).toContain("Ana Vainqueur");
    expect(comp).toContain("640,5");
    const csv = await (await req(`${compUrl}/standings.csv`)).text();
    expect(csv.split("\n")[1]).toBe("1,12,Ana Vainqueur,1000.0,1000.0,1000.0,1000.0");
    expect(await (await req(`${compUrl}?all=1`)).text()).toContain("Bruno Second");
    // L'ancienne page des classements renvoie vers la page de la compétition.
    expect((await req(`${compUrl}/standings`)).headers.get("location")).toBe(`${compUrl}?all=1#standings`);
    await req(`${taskUrl}/official`, { method: "POST", body: new URLSearchParams({ official: "0" }) });
    expect(await (await req(compUrl)).text()).toContain("Aucune manche officielle calculée");
  });

  it("importe, modifie et retire les pilotes inscrits", async () => {
    const { req, db } = setup();
    const { compUrl } = await createCompetitionAndTask(req);
    const f = new FormData();
    f.append("file", new Blob([readFileSync(new URL("fixtures/sample.fsdb", import.meta.url))]), "comp.fsdb");
    const r = await req(`${compUrl}/pilots/import`, { method: "POST", body: f });
    expect(r.status).toBe(302);
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("2 pilotes ajoutés");
    expect(r.headers.get("location")).toContain("/edit?");
    const html = await (await req(`${compUrl}/edit`)).text();
    expect(html).toContain("2 inscrits · 1 femme");
    const rows = db.prepare("SELECT id, pilot_key FROM competition_pilots ORDER BY id").all() as Array<{ id: number; pilot_key: string }>;
    // Échange des numéros, retrait d'un pilote et ajout d'un nouveau en un seul enregistrement.
    const body = new URLSearchParams({
      [`p.${rows[0]!.id}.pilot_key`]: "269",
      [`p.${rows[0]!.id}.name`]: "Baptiste Lambert",
      [`p.${rows[1]!.id}.pilot_key`]: "2",
      [`p.${rows[1]!.id}.name`]: "Mélanie Pfister",
      [`p.${rows[1]!.id}.gender`]: "F",
      [`del.${rows[0]!.id}`]: "1",
      "new.pilot_key": "50",
      "new.name": "Nouveau Pilote",
      "new.weight_max": "105",
    });
    expect((await req(`${compUrl}/pilots`, { method: "POST", body })).status).toBe(302);
    const after = db.prepare("SELECT pilot_key, name, gender, weight_max FROM competition_pilots ORDER BY CAST(pilot_key AS INTEGER)").all();
    expect(after.map((x) => ({ ...x }))).toEqual([
      { pilot_key: "2", name: "Mélanie Pfister", gender: "F", weight_max: null },
      { pilot_key: "50", name: "Nouveau Pilote", gender: null, weight_max: 105 },
    ]);
    const bad = await req(`${compUrl}/pilots`, { method: "POST", body: new URLSearchParams({ "new.pilot_key": "2", "new.name": "Doublon" }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("déjà inscrit");
    expect(await (await req(`${compUrl}/pilots.csv`)).text()).toContain("50,Nouveau Pilote,,,,,,,,,105");
  });

  it("extrait le classement féminin et les classements créés par l'organisateur", async () => {
    const { req, db } = setup();
    const { compUrl, taskUrl } = await createCompetitionAndTask(req);
    const taskId = Number(taskUrl.split("/").pop());
    const results = {
      pilots: [
        { id: "12", name: "trace 12", total: 1000, airspace: [], distance: 0 },
        { id: "7", name: "trace 7", total: 800, airspace: [], distance: 0 },
        { id: "9", name: "trace 9", total: 640.5, airspace: [], distance: 0 },
        { id: "3", name: "trace 3", total: 300, airspace: [], distance: 0 },
      ],
      gap: { validity: { task: 1 }, available: { distance: 400, time: 350, leading: 250, arrival: 0 } },
    };
    db.prepare("INSERT INTO runs (task_id, status, results, started_at, finished_at) VALUES (?, 'done', ?, ?, ?)").run(taskId, JSON.stringify(results), Date.now() + 1000, Date.now() + 2000);
    await req(`${taskUrl}/official`, { method: "POST", body: new URLSearchParams({ official: "1" }) });
    const csv = "numero;nom;genre;voile;classe;ptv\n12;Ana;F;Ozone Zeno 2;EN-D;95\n7;Bruno;M;Gin Leopard;EN-C;110\n9;Chloé;F;Ozone Rush 6;EN-B;85\n3;Dan;M;Ozone Enzo 3;CCC;100\n";
    const f = new FormData();
    f.append("file", new Blob([csv]), "inscrits.csv");
    await req(`${compUrl}/pilots/import`, { method: "POST", body: f });
    // Le classement féminin existe d'office ; c'est le seul.
    const rk = db.prepare("SELECT id, name FROM competition_rankings").all() as Array<{ id: number; name: string }>;
    expect(rk.map((r) => r.name)).toEqual(["Féminin"]);
    const fem = await (await req(`${compUrl}/standings.csv?r=${rk[0]!.id}`)).text();
    expect(fem.split("\n").slice(1, 3).map((l) => l.split(",").slice(0, 3).join(","))).toEqual(["1,12,Ana", "2,9,Chloé"]);
    // Serial : EN-C ou EN-D, poids ≤ 110 ; puis Dan ajouté à la main et Ana retirée.
    const rc = await req(`${compUrl}/rankings`, {
      method: "POST",
      body: new URLSearchParams({ name: "Serial", field1: "glider_class", op1: "in", value1: "EN-C, en d", field2: "weight_max", op2: "lte", value2: "110" }),
    });
    const serialUrl = rc.headers.get("location")!.split("&")[0]!;
    const rid = serialUrl.split("r=")[1]!;
    const lines = async () => (await (await req(`${compUrl}/standings.csv?r=${rid}`)).text()).trim().split("\n").slice(1).map((l) => l.split(",").slice(0, 2).join(","));
    expect(await lines()).toEqual(["1,12", "2,7"]);
    await req(`${compUrl}/rankings/${rid}/pilots`, { method: "POST", body: new URLSearchParams({ pilot: "3", how: "include" }) });
    await req(`${compUrl}/rankings/${rid}/pilots`, { method: "POST", body: new URLSearchParams({ pilot: "12", how: "exclude" }) });
    expect(await lines()).toEqual(["1,7", "2,3"]);
    // Même classement à la manche : ses pilotes, rang recalculé, et un lien depuis la liste des manches.
    const taskCsv = (await (await req(`${taskUrl}/results.csv?r=${rid}`)).text()).trim().split("\n").slice(1).map((l) => l.split(",").slice(0, 2).join(","));
    expect(taskCsv).toEqual(["1,7", "2,3"]);
    expect(await (await req(compUrl)).text()).toContain(`${taskUrl}?r=${rid}#results`);
    const page = await (await req(serialUrl)).text();
    expect(page).toContain("EN-C, en d et ptv max (kg) ≤ 110");
    expect(page).toContain("revenir à la règle");
    const bad = await req(`${compUrl}/rankings`, { method: "POST", body: new URLSearchParams({ name: "X", field1: "weight_max", op1: "in", value1: "90" }) });
    expect(bad.status).toBe(400);
    await req(`${compUrl}/rankings/${rid}/delete`, { method: "POST" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM competition_rankings").get() as { n: number }).n).toBe(1);
  });

  it("propose l'import civlcomps et refuse une adresse d'un autre site", async () => {
    const { req } = setup();
    await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "orga@example.org", name: "Orga" }) });
    expect(await (await req("/competitions/new")).text()).toContain('name="civl_url"');
    const r = await req("/competitions/import", { method: "POST", body: new URLSearchParams({ civl_url: "https://example.org/event/x/results" }) });
    expect(r.status).toBe(302);
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("civlcomps.org");
  });

  it("refuse une manche illisible", async () => {
    const { req } = setup();
    const { compUrl } = await createCompetitionAndTask(req);
    const ft = new FormData();
    ft.append("number", "4");
    ft.append("text", "XCTSK:{pas du json");
    const r = await req(`${compUrl}/tasks`, { method: "POST", body: ft });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Manche illisible");
  });

  it("montre les compétitions des autres en lecture seule, sauf aux administrateurs", async () => {
    const { req } = setup(["Admin@Example.org"]);
    const { compUrl, taskUrl } = await createCompetitionAndTask(req);
    const taskId = taskUrl.split("/").pop();
    const login = async (email: string) => {
      await req("/auth/logout", { method: "POST" });
      await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email }) });
    };
    await login("autre@example.org");
    expect(await (await req("/")).text()).toContain("Récemment calculées");
    const comp = await (await req(compUrl)).text();
    expect(comp).toContain("Coupe test");
    expect(comp).not.toContain(`${compUrl}/edit`);
    expect(comp).not.toContain("/official");
    expect(comp).not.toContain("Nouvelle manche");
    expect(comp).not.toContain("Nouveau classement");
    expect((await req(taskUrl)).status).toBe(200);
    expect(await (await req(taskUrl)).text()).not.toContain(`${taskUrl}/edit`);
    for (const path of [`${compUrl}/edit`, `${compUrl}/tasks/new`, `${taskUrl}/edit`]) expect((await req(path)).status).toBe(302);
    const posts: Array<[string, BodyInit]> = [
      [`/tasks/${taskId}/official`, new URLSearchParams({ official: "1" })],
      [compUrl, new URLSearchParams(competitionFields)],
      [`${compUrl}/rankings`, new URLSearchParams({ name: "X" })],
      [`${compUrl}/tasks`, new URLSearchParams({ number: "9", text: QR })],
      [`${compUrl}/pilots/import`, new FormData()],
      [taskUrl, new URLSearchParams({ date: "2026-07-28" })],
      [`${taskUrl}/runs`, new URLSearchParams()],
      [`${taskUrl}/decisions`, new URLSearchParams({ pilot: "1", kind: "goal", reason: "x" })],
      [`${taskUrl}/tracks`, new FormData()],
    ];
    for (const [path, body] of posts) expect((await req(path, { method: "POST", body })).status, path).toBe(403);
    await req("/auth/logout", { method: "POST" });
    expect(await (await req(compUrl)).text()).toContain("Coupe test");
    expect((await req(taskUrl)).status).toBe(200);
    expect((await req(`${taskUrl}/edit`)).headers.get("location")).toBe("/login");
    expect((await req(`/tasks/${taskId}/official`, { method: "POST", body: new URLSearchParams({ official: "1" }) })).headers.get("location")).toBe("/login");
    await login("admin@example.org");
    expect(await (await req(compUrl)).text()).toContain(`${compUrl}/edit`);
    expect((await req(`/tasks/${taskId}/official`, { method: "POST", body: new URLSearchParams({ official: "1" }) })).status).toBe(302);
  });

  it("seul un administrateur supprime une compétition, en recopiant son nom", async () => {
    const { db, req } = setup(["admin@example.org"]);
    const { compUrl } = await createCompetitionAndTask(req);
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM competitions").get() as { n: number }).n;
    // Le propriétaire ne voit pas le bouton et ne peut pas supprimer.
    expect(await (await req(`${compUrl}/edit`)).text()).not.toContain("/delete");
    expect((await req(`${compUrl}/delete`, { method: "POST", body: new URLSearchParams({ confirm: "Coupe test" }) })).status).toBe(403);
    await req("/auth/logout", { method: "POST" });
    await req("/auth/dev", { method: "POST", body: new URLSearchParams({ email: "admin@example.org" }) });
    const page = await (await req(`${compUrl}/edit`)).text();
    expect(page).toContain(`${compUrl}/delete`);
    expect(page).toContain("return confirm(");
    // Mauvais nom : rien n'est supprimé.
    const bad = await req(`${compUrl}/delete`, { method: "POST", body: new URLSearchParams({ confirm: "Coupe" }) });
    expect(bad.headers.get("location")).toContain("error=");
    expect(count()).toBe(1);
    const ok = await req(`${compUrl}/delete`, { method: "POST", body: new URLSearchParams({ confirm: "Coupe test" }) });
    expect(ok.headers.get("location")).toContain("/?msg=");
    expect(count()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(0);
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
    await req(`${taskUrl}/decisions`, { method: "POST", body: new URLSearchParams({ pilot: "260", kind: "bonus", value: "100", reason: "Aide" }) });
    await req(`${taskUrl}/runs`, { method: "POST" });
    // Avancement lisible pendant le calcul : étape, compteurs.
    const live = await (await req(`${taskUrl}/run.json`)).json();
    expect(["queued", "running", "done"]).toContain(live.status);
    expect(live.total).toBe(4);
    let html = "";
    for (let i = 0; i < 100; i++) {
      html = await (await req(taskUrl)).text();
      if (!html.includes("Calcul en cours")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(html).toContain("Baptiste Lambert");
    expect(html).toContain("MIND");
    // Détail du calcul (espaces aériens, validité, points disponibles) : dans l'onglet « Éditer ».
    const edit = await (await req(`${taskUrl}/edit`)).text();
    expect(edit).toContain("RISERVA CORNINO");
    const details = await (await req(`${taskUrl}?view=details`)).text();
    expect(details).toContain("Validité de la manche");
    expect(details).toContain("Points disponibles");
    const csv = await (await req(`${taskUrl}/results.csv`)).text();
    const [head, first] = csv.split("\n");
    expect(first).toContain("GOAL");
    // Premier du classement : le pilote au goal, avec ses points.
    const total = head!.split(",").indexOf("total");
    expect(Number(first!.split(",")[total])).toBeGreaterThan(500);
    expect(csv).toContain("Bonus 100 pts : Aide");
    const end = await (await req(`${taskUrl}/run.json`)).json();
    expect(end).toMatchObject({ status: "done", step: "save", done: 4 });
    expect(end.detail.counts.GOAL).toBeGreaterThan(0);
  });
});
