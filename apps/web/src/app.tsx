import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parseOpenAir, parseXctsk, taskDistances, type Task } from "@pgscore/engine";
import {
  createSession,
  deleteSession,
  GOOGLE_ISSUER,
  handleCallback,
  loginUrl,
  SESSION_COOKIE,
  sessionUser,
  upsertUser,
  type OidcConfig,
} from "./auth.js";
import type { CompetitionRow, Db, RunRow, TaskRow, TrackRow, User } from "./db.js";
import { collectIgc, decodeQrImage, decodeText, pilotKeyFromFilename } from "./files.js";
import { isRunning, startRun } from "./runner.js";
import type { TrackStore } from "./track-store.js";
import { pilotVersions, removeTrack, saveTrack, taskHasFile, trackHistory } from "./tracks.js";
import { DEFAULT_SETTINGS, FormError, parseSettings, settingsFromForm, taskScoringFromForm, type StoredTask } from "./settings.js";
import { localHmsToUtc } from "./time.js";
import { taskGeometry, viewerData } from "./viewer-data.js";
import { vendorFile } from "./vendor.js";
import { readFileSync } from "node:fs";
import {
  CompetitionPage,
  HomePage,
  LoginPage,
  NewCompetitionPage,
  NewTaskPage,
  NotFound,
  resultsCsv,
  TaskPage,
  ViewerPage,
  type CompetitionFormValues,
} from "./views.js";
import type { TaskScoring } from "@pgscore/engine";

export interface AppConfig {
  baseUrl: string;
  google?: { clientId: string; clientSecret: string };
  /** Connexion sans fournisseur, pour le développement et les tests. */
  devLogin?: boolean;
  /** Cookies « Secure » (vrai dès que l'appli est servie en HTTPS). */
  secureCookies?: boolean;
}

type Env = { Variables: { user: User } };

const MAX_UPLOAD = 200 * 1024 * 1024;

/** Nom du pilote dans l'en-tête IGC (HFPLT). */
const igcPilot = (text: string) => /^HF[A-Z]{0,3}PLT[^:]*:(.*)$/im.exec(text)?.[1]?.trim() || null;

export function createApp(db: Db, tracks: TrackStore, cfg: AppConfig) {
  const app = new Hono<Env>();
  const oidc: OidcConfig | null = cfg.google
    ? { provider: "google", issuer: GOOGLE_ISSUER, clientId: cfg.google.clientId, clientSecret: cfg.google.clientSecret, baseUrl: cfg.baseUrl }
    : null;

  const signIn = (c: Context, user: User) => {
    const s = createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "Lax", secure: cfg.secureCookies ?? false, path: "/", maxAge: s.maxAge });
    return c.redirect("/");
  };

  // Les formulaires viennent de nos pages : on refuse les POST d'une autre origine.
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin && origin !== new URL(cfg.baseUrl).origin && origin !== new URL(c.req.url).origin) return c.text("Origine refusée", 403);
    }
    await next();
  });

  // Scripts de l'interface, lus au démarrage.
  const scripts = Object.fromEntries(
    ["viewer.js", "run.js", "taskmap.js", "basemaps.js"].map((f) => [f, readFileSync(new URL(`./static/${f}`, import.meta.url), "utf8")]),
  );
  // Contrôle de santé pour l'hébergeur : le serveur répond et la base est lisible.
  app.get("/healthz", (c) => {
    db.prepare("SELECT 1").get();
    return c.text("ok");
  });
  app.get("/static/:file", (c) => {
    const js = scripts[c.req.param("file")];
    return js ? c.body(js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }) : c.notFound();
  });

  app.get("/vendor/:lib/*", (c) => {
    const lib = c.req.param("lib");
    const f = vendorFile(lib, c.req.path.slice(`/vendor/${lib}/`.length));
    if (!f) return c.notFound();
    return c.body(new Uint8Array(f.body), 200, { "content-type": f.type, "cache-control": "public, max-age=86400" });
  });

  // --- Connexion ---------------------------------------------------------------------------
  const loginPage = (c: Context, error?: string) =>
    c.html(
      <LoginPage
        providers={oidc ? [{ href: "/auth/login/google", label: "Se connecter avec Google" }] : []}
        devLogin={cfg.devLogin === true}
        error={error ?? null}
      />,
      error ? 400 : 200,
    );

  app.get("/auth/login/google", async (c) => {
    if (!oidc) return c.notFound();
    try {
      return c.redirect(await loginUrl(db, oidc));
    } catch (e) {
      return loginPage(c, (e as Error).message);
    }
  });

  app.get("/auth/callback", async (c) => {
    if (!oidc) return c.notFound();
    const { code, state, error } = c.req.query();
    if (error || !code || !state) return loginPage(c, error === "access_denied" ? "Connexion annulée." : "Connexion impossible.");
    try {
      return signIn(c, await handleCallback(db, oidc, code, state));
    } catch (e) {
      return loginPage(c, (e as Error).message);
    }
  });

  app.post("/auth/dev", async (c) => {
    if (!cfg.devLogin) return c.notFound();
    const f = await c.req.parseBody();
    const email = String(f.email ?? "").trim().toLowerCase();
    if (!email) return loginPage(c, "E-mail obligatoire.");
    return signIn(c, upsertUser(db, "dev", email, email, String(f.name ?? "").trim() || null));
  });

  app.post("/auth/logout", (c) => {
    deleteSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  // --- Tout le reste demande d'être connecté -----------------------------------------------
  app.use("*", async (c, next) => {
    const user = sessionUser(db, getCookie(c, SESSION_COOKIE));
    if (!user) return c.req.method === "GET" ? loginPage(c) : c.redirect("/");
    c.set("user", user);
    await next();
  });

  const competition = (c: Context<Env>, id: string): CompetitionRow | null => {
    const row = db.prepare("SELECT * FROM competitions WHERE id = ? AND owner_id = ?").get(Number(id), c.get("user").id) as unknown as
      | CompetitionRow
      | undefined;
    return row ?? null;
  };
  const taskOf = (c: Context<Env>, id: string): { t: TaskRow; comp: CompetitionRow } | null => {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(id)) as unknown as TaskRow | undefined;
    const comp = t ? competition(c, String(t.competition_id)) : null;
    return t && comp ? { t, comp } : null;
  };
  const notFound = (c: Context<Env>) => c.html(<NotFound user={c.get("user")} />, 404);

  app.get("/", (c) => {
    const rows = db
      .prepare("SELECT * FROM competitions WHERE owner_id = ? ORDER BY COALESCE(start_date, '') DESC, id DESC")
      .all(c.get("user").id) as unknown as CompetitionRow[];
    return c.html(<HomePage user={c.get("user")} competitions={rows} />);
  });

  // --- Compétitions ------------------------------------------------------------------------
  const formValues = (f: Record<string, unknown>, fallback = DEFAULT_SETTINGS): CompetitionFormValues => {
    let settings = fallback;
    try {
      settings = settingsFromForm(f);
    } catch {
      /* on réaffiche les valeurs précédentes */
    }
    return {
      name: String(f.name ?? ""),
      location: String(f.location ?? ""),
      start_date: String(f.start_date ?? ""),
      end_date: String(f.end_date ?? ""),
      settings,
    };
  };
  const rowValues = (r: CompetitionRow): CompetitionFormValues => ({
    name: r.name,
    location: r.location ?? "",
    start_date: r.start_date ?? "",
    end_date: r.end_date ?? "",
    settings: parseSettings(r.params),
  });

  const readAirspace = async (file: unknown): Promise<{ name: string; text: string; count: number } | null> => {
    if (!(file instanceof File) || !file.size) return null;
    const text = decodeText(new Uint8Array(await file.arrayBuffer()));
    let count;
    try {
      count = parseOpenAir(text).length;
    } catch (e) {
      throw new FormError(`Fichier OpenAir illisible : ${(e as Error).message}`);
    }
    if (!count) throw new FormError("Aucune zone trouvée dans le fichier OpenAir.");
    return { name: file.name, text, count };
  };

  app.get("/competitions/new", (c) =>
    c.html(<NewCompetitionPage user={c.get("user")} v={{ name: "", location: "", start_date: "", end_date: "", settings: DEFAULT_SETTINGS }} />),
  );

  app.post("/competitions", async (c) => {
    const f = await c.req.parseBody();
    try {
      const name = String(f.name ?? "").trim();
      if (!name) throw new FormError("Le nom est obligatoire.");
      const settings = settingsFromForm(f);
      const air = await readAirspace(f.airspace);
      const r = db
        .prepare(
          `INSERT INTO competitions (owner_id, name, location, start_date, end_date, params, airspace_name, airspace_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.get("user").id,
          name,
          String(f.location ?? "").trim() || null,
          String(f.start_date ?? "") || null,
          String(f.end_date ?? "") || null,
          JSON.stringify(settings),
          air?.name ?? null,
          air?.text ?? null,
          Date.now(),
        );
      return c.redirect(`/competitions/${r.lastInsertRowid}`);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return c.html(<NewCompetitionPage user={c.get("user")} v={formValues(f)} error={e.message} />, 400);
    }
  });

  const competitionPage = (c: Context<Env>, comp: CompetitionRow, extra: { error?: string; notice?: string; v?: CompetitionFormValues } = {}) => {
    const tasks = db.prepare("SELECT * FROM tasks WHERE competition_id = ? ORDER BY number").all(comp.id) as unknown as TaskRow[];
    let count: number | null = null;
    if (comp.airspace_text) {
      try {
        count = parseOpenAir(comp.airspace_text).length;
      } catch {
        count = 0;
      }
    }
    return c.html(
      <CompetitionPage
        user={c.get("user")}
        c={comp}
        v={extra.v ?? rowValues(comp)}
        tasks={tasks}
        airspaceCount={count}
        error={extra.error ?? null}
        notice={extra.notice ?? null}
      />,
      extra.error ? 400 : 200,
    );
  };

  app.get("/competitions/:id", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    return competitionPage(c, comp, c.req.query("ok") ? { notice: "Enregistré." } : {});
  });

  app.post("/competitions/:id", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    try {
      const name = String(f.name ?? "").trim();
      if (!name) throw new FormError("Le nom est obligatoire.");
      const s = settingsFromForm(f);
      db.prepare("UPDATE competitions SET name = ?, location = ?, start_date = ?, end_date = ?, params = ? WHERE id = ?").run(
        name,
        String(f.location ?? "").trim() || null,
        String(f.start_date ?? "") || null,
        String(f.end_date ?? "") || null,
        JSON.stringify(s),
        comp.id,
      );
      return c.redirect(`/competitions/${comp.id}?ok=1`);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return competitionPage(c, comp, { error: e.message, v: formValues(f, parseSettings(comp.params)) });
    }
  });

  app.post("/competitions/:id/airspace", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    try {
      const air = await readAirspace(f.airspace);
      if (!air) throw new FormError("Choisissez un fichier OpenAir.");
      db.prepare("UPDATE competitions SET airspace_name = ?, airspace_text = ? WHERE id = ?").run(air.name, air.text, comp.id);
      return c.redirect(`/competitions/${comp.id}?ok=1`);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return competitionPage(c, comp, { error: e.message });
    }
  });

  // --- Manches -----------------------------------------------------------------------------
  app.get("/competitions/:id/tasks/new", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const n = (db.prepare("SELECT COALESCE(MAX(number), 0) + 1 n FROM tasks WHERE competition_id = ?").get(comp.id) as { n: number }).n;
    return c.html(<NewTaskPage user={c.get("user")} c={comp} number={n} />);
  });

  app.post("/competitions/:id/tasks", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    const number = Number(f.number) || 1;
    const date = String(f.date ?? "") || null;
    try {
      let source: string;
      let text: string;
      if (f.xctsk instanceof File && f.xctsk.size) {
        source = "xctsk";
        text = decodeText(new Uint8Array(await f.xctsk.arrayBuffer()));
      } else if (f.qr instanceof File && f.qr.size) {
        source = "qr-image";
        let decoded;
        try {
          decoded = decodeQrImage(new Uint8Array(await f.qr.arrayBuffer()));
        } catch (e) {
          throw new FormError((e as Error).message);
        }
        if (!decoded) throw new FormError("Aucun QR code lisible dans l'image. Essayez une image plus nette ou collez le texte.");
        text = decoded;
      } else if (String(f.text ?? "").trim()) {
        source = "qr-text";
        text = String(f.text).trim();
      } else throw new FormError("Envoyez un fichier .xctsk, une image du QR code ou son texte.");
      let task: Task;
      try {
        task = parseXctsk(text.trim());
        taskDistances(task);
      } catch (e) {
        throw new FormError(`Manche illisible : ${(e as Error).message}`);
      }
      const r = db
        .prepare("INSERT INTO tasks (competition_id, number, date, source, source_text, task, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(comp.id, number, date, source, text, JSON.stringify(task), Date.now());
      return c.redirect(`/tasks/${r.lastInsertRowid}?created=1`);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return c.html(<NewTaskPage user={c.get("user")} c={comp} number={number} error={e.message} {...(date ? { date } : {})} />, 400);
    }
  });

  const taskPage = (c: Context<Env>, t: TaskRow, comp: CompetitionRow, extra: { error?: string; notice?: string } = {}) => {
    const task = JSON.parse(t.task) as Task;
    const tracks = db
      .prepare("SELECT * FROM tracks WHERE task_id = ? ORDER BY CAST(pilot_key AS INTEGER), pilot_key")
      .all(t.id) as unknown as TrackRow[];
    const run = (db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(t.id) as unknown as RunRow | undefined) ?? null;
    return c.html(
      <TaskPage
        user={c.get("user")}
        c={comp}
        t={t}
        task={task}
        settings={parseSettings(comp.params)}
        distances={taskDistances(task)}
        tracks={tracks}
        history={trackHistory(db, t.id)}
        geometry={JSON.stringify(taskGeometry(task))}
        run={run}
        running={isRunning(t.id) || run?.status === "running" || run?.status === "queued"}
        error={extra.error ?? null}
        notice={extra.notice ?? null}
      />,
      extra.error ? 400 : 200,
    );
  };

  app.get("/tasks/:id", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const q = (k: string) => Number(c.req.query(k) ?? 0);
    const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
    const parts = [
      q("added") ? plural(q("added"), "trace ajoutée", "traces ajoutées") : "",
      q("replaced") ? plural(q("replaced"), "trace remplacée", "traces remplacées") : "",
      q("same") ? plural(q("same"), "fichier identique à la trace en place, ignoré", "fichiers identiques aux traces en place, ignorés") : "",
    ].filter(Boolean);
    if (c.req.query("created")) parts.unshift("Manche créée : vérifiez le parcours sur la carte avant d'envoyer les traces");
    return taskPage(c, x.t, x.comp, parts.length ? { notice: `${parts.join(", ")}.` } : {});
  });

  app.post("/tasks/:id", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const f = await c.req.parseBody();
    const task = JSON.parse(x.t.task) as StoredTask;
    const date = String(f.date ?? "") || null;
    const stop = String(f.stop ?? "").trim();
    const end = String(f.taskEndTime ?? "").trim();
    try {
      const tz = parseSettings(x.comp.params).timeZone;
      if (stop) task.stopAnnouncement = localHmsToUtc(stop, date, tz);
      else delete task.stopAnnouncement;
      delete task.leadingTimeRatio;
      delete task.pilotsPresent;
      delete task.taskEndTime;
      Object.assign(task, taskScoringFromForm(f));
      if (end) task.taskEndTime = localHmsToUtc(end, date, tz);
    } catch (e) {
      return taskPage(c, x.t, x.comp, { error: (e as Error).message });
    }
    db.prepare("UPDATE tasks SET date = ?, task = ? WHERE id = ?").run(date, JSON.stringify(task), x.t.id);
    return c.redirect(`/tasks/${x.t.id}`);
  });

  app.post("/tasks/:id/tracks", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD) return taskPage(c, x.t, x.comp, { error: "Envoi trop gros (200 Mo au plus)." });
    const f = await c.req.parseBody({ all: true });
    const list = ([] as unknown[]).concat(f.files ?? []).filter((v): v is File => v instanceof File && v.size > 0);
    let igcs;
    try {
      igcs = collectIgc(await Promise.all(list.map(async (v) => ({ name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) }))));
    } catch (e) {
      return taskPage(c, x.t, x.comp, { error: `Archive illisible : ${(e as Error).message}` });
    }
    if (!igcs.length) return taskPage(c, x.t, x.comp, { error: "Aucun fichier IGC trouvé dans l'envoi." });
    // Fichiers écrits sur disque avant la base : une ligne de la base pointe toujours vers un fichier présent.
    const stored = igcs.map((g) => ({ g, sha256: tracks.put(g.bytes) }));
    const count = { added: 0, replaced: 0, same: 0 };
    db.exec("BEGIN");
    for (const { g, sha256 } of stored) {
      count[saveTrack(db, x.t.id, c.get("user").id, { pilotKey: pilotKeyFromFilename(g.filename), pilotName: igcPilot(g.text), filename: g.filename, sha256, size: g.bytes.length })]++;
    }
    db.exec("COMMIT");
    return c.redirect(`/tasks/${x.t.id}?${new URLSearchParams(Object.entries(count).filter(([, n]) => n).map(([k, n]) => [k, String(n)]))}`);
  });

  // Remplacer la trace d'un pilote donné, quel que soit le nom du nouveau fichier. Le pilote garde son
  // nom : l'en-tête du nouveau fichier peut porter un autre nom (instrument prêté).
  app.post("/tasks/:id/tracks/:trackId/replace", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const tr = db.prepare("SELECT * FROM tracks WHERE id = ? AND task_id = ?").get(Number(c.req.param("trackId")), x.t.id) as unknown as TrackRow | undefined;
    if (!tr) return notFound(c);
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD) return taskPage(c, x.t, x.comp, { error: "Envoi trop gros (200 Mo au plus)." });
    const f = await c.req.parseBody();
    const file = f.file instanceof File && f.file.size > 0 ? f.file : null;
    if (!file) return taskPage(c, x.t, x.comp, { error: "Choisissez le nouveau fichier IGC." });
    let igcs;
    try {
      igcs = collectIgc([{ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }]);
    } catch (e) {
      return taskPage(c, x.t, x.comp, { error: `Archive illisible : ${(e as Error).message}` });
    }
    if (igcs.length !== 1) {
      return taskPage(c, x.t, x.comp, { error: igcs.length ? "L'archive contient plusieurs traces : envoyez un seul fichier IGC." : "Ce fichier n'est pas une trace IGC." });
    }
    const g = igcs[0]!;
    const note = typeof f.note === "string" && f.note.trim() ? f.note.trim().slice(0, 500) : null;
    const sha256 = tracks.put(g.bytes);
    const how = saveTrack(db, x.t.id, c.get("user").id, { pilotKey: tr.pilot_key, pilotName: tr.pilot_name ?? igcPilot(g.text), filename: g.filename, sha256, size: g.bytes.length, note });
    if (how === "same") return taskPage(c, x.t, x.comp, { notice: `Ce fichier est déjà la trace de ${tr.pilot_name ?? tr.pilot_key} : rien n'a changé.` });
    return c.redirect(`/tasks/${x.t.id}?replaced=1`);
  });

  // Fichier IGC d'origine (trace en vigueur ou ancienne version), pour l'organisateur.
  app.get("/tasks/:id/files/:sha", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const sha = c.req.param("sha");
    const f = /^[0-9a-f]{64}$/.test(sha) ? taskHasFile(db, x.t.id, sha) : null;
    if (!f) return notFound(c);
    return c.body(new Uint8Array(tracks.bytes(sha)), 200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`,
    });
  });

  app.post("/tasks/:id/tracks/:trackId/delete", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    removeTrack(db, x.t.id, Number(c.req.param("trackId")), c.get("user").id);
    return c.redirect(`/tasks/${x.t.id}`);
  });

  app.post("/tasks/:id/runs", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    try {
      startRun(db, tracks, x.t.id, c.get("user").id);
    } catch (e) {
      return taskPage(c, x.t, x.comp, { error: (e as Error).message });
    }
    return c.redirect(`/tasks/${x.t.id}`);
  });

  app.get("/tasks/:id/pilots/:key", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const key = c.req.param("key");
    const versions = pilotVersions(db, x.t.id, key);
    if (!versions.length) return notFound(c);
    const data = viewerData(
      JSON.parse(x.t.task) as Task,
      versions.map((v) => ({ igc: tracks.text(v.meta.sha256), meta: v.meta })),
      x.comp.airspace_text,
      parseSettings(x.comp.params),
      { key, name: versions.find((v) => v.pilotName)?.pilotName ?? null },
      x.t.date,
    );
    return c.html(<ViewerPage user={c.get("user")} c={x.comp} t={x.t} pilotKey={key} pilotName={data.pilot.name} data={JSON.stringify(data)} />);
  });

  // Avancement du dernier calcul, relu chaque seconde par la page de la manche.
  app.get("/tasks/:id/run.json", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const run = db.prepare("SELECT id, status, step, done, total, detail, error, started_at, finished_at FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(x.t.id) as
      | (Omit<RunRow, "results" | "task_id">)
      | undefined;
    if (!run) return c.json({ status: "none" });
    return c.json({
      id: run.id,
      status: run.status,
      step: run.step,
      done: run.done,
      total: run.total,
      detail: run.detail ? JSON.parse(run.detail) : {},
      error: run.error,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      now: Date.now(),
    }, 200, { "cache-control": "no-store" });
  });

  app.get("/tasks/:id/results.csv", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const run = db.prepare("SELECT results FROM runs WHERE task_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(x.t.id) as
      | { results: string }
      | undefined;
    if (!run) return notFound(c);
    const csv = resultsCsv(JSON.parse(run.results) as TaskScoring, parseSettings(x.comp.params).timeZone);
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="manche-${x.t.number}.csv"`,
    });
  });

  app.notFound((c) => c.html(<NotFound />, 404));
  return app;
}
