import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parseOpenAir, parseXctsk, taskDistances, taskToXctskQr, type Task } from "@pgscore/engine";
import qrcode from "qrcode-generator";
import {
  apiTokenUser,
  createApiToken,
  createSession,
  deleteApiToken,
  listApiTokens,
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
import { collectIgc, decodeQrImage, decodeText, nameKey, pilotKeyForTrack } from "./files.js";
import { isRunning, startRun } from "./runner.js";
import type { TrackStore } from "./track-store.js";
import { pilotVersions, removeTrack, saveTrack, taskHasFile, trackHistory } from "./tracks.js";
import { addDecision, deleteDecision, listDecisions, touchScoring } from "./decisions.js";
import { DEFAULT_SETTINGS, FormError, parseSettings, settingsFromForm, taskScoringFromForm, type StoredTask } from "./settings.js";
import { localHmsToUtc } from "./time.js";
import { clientScript, isLang, lang, LANG_COOKIE, pickLang, t, withLang } from "./i18n.js";
import { competitionStandings, extractStandings, lastScoringChange, standingsCsv } from "./standings.js";
import { addDefaultRankings, createRanking, deleteRanking, getRanking, listRankings, rankingMembers, setOverride, updateRanking } from "./rankings.js";
import { listPilots, pilotsCsv, pilotsFromFile, savePilotTable, upsertPilots } from "./pilots.js";
import { taskGeometry, viewerData } from "./viewer-data.js";
import { vendorFile } from "./vendor.js";
import { exportCompetition, importCompetition, writeArchive } from "./archive.js";
import { competitionFsdb, competitionFsdbZip, fsdbToArchive, looksLikeFsdb } from "./fsdb.js";
import { readFileSync } from "node:fs";
import {
  AccountPage,
  ApiDocPage,
  AboutPage,
  CompetitionPage,
  HomePage,
  LoginPage,
  NewCompetitionPage,
  NewTaskPage,
  NotFound,
  resultsCsv,
  RunCard,
  boardUrl,
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
  /** Adresses e-mail des administrateurs : ils modifient toutes les compétitions. */
  adminEmails?: string[];
}

type Env = { Variables: { user: User | null } };

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

  // Langue de l'interface : cookie, sinon langue du navigateur.
  app.use("*", (c, next) => withLang(pickLang(getCookie(c, LANG_COOKIE), c.req.header("accept-language")), next));
  app.get("/lang/:code", (c) => {
    const code = c.req.param("code");
    if (isLang(code)) setCookie(c, LANG_COOKIE, code, { path: "/", maxAge: 365 * 86400, sameSite: "Lax" });
    // Retour à la page d'où vient le clic (même site seulement).
    let back = c.req.query("back") ?? "/";
    const ref = c.req.header("referer");
    if (!c.req.query("back") && ref) {
      try {
        const u = new URL(ref);
        if (u.host === new URL(c.req.url).host) back = u.pathname + u.search + u.hash;
      } catch {
        /* adresse illisible : accueil */
      }
    }
    return c.redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/");
  });
  app.get("/static/i18n.js", (c) => c.body(clientScript(lang()), 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", vary: "cookie" }));

  // Les formulaires viennent de nos pages : on refuse les POST d'une autre origine.
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin && origin !== new URL(cfg.baseUrl).origin && origin !== new URL(c.req.url).origin) return c.text(t("Origine refusée"), 403);
    }
    await next();
  });

  // Scripts de l'interface, lus au démarrage.
  const scripts = Object.fromEntries(
    ["viewer.js", "run.js", "taskmap.js", "basemaps.js", "competition.js"].map((f) => [f, readFileSync(new URL(`./static/${f}`, import.meta.url), "utf8")]),
  );
  // Contrôle de santé pour l'hébergeur : le serveur répond et la base est lisible.
  app.get("/healthz", (c) => {
    db.prepare("SELECT 1").get();
    return c.text("ok");
  });
  // Logo du projet (route optimisée qui frôle les cylindres), aussi icône d'onglet.
  const logo = readFileSync(new URL("./static/logo.svg", import.meta.url), "utf8");
  const sendLogo = (c: Context) => c.body(logo, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
  app.get("/logo.svg", sendLogo);
  app.get("/favicon.svg", sendLogo);
  app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));
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
        providers={oidc ? [{ href: "/auth/login/google", label: t("Se connecter avec Google") }] : []}
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
    if (error || !code || !state) return loginPage(c, error === "access_denied" ? t("Connexion annulée.") : t("Connexion impossible."));
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
    if (!email) return loginPage(c, t("E-mail obligatoire."));
    return signIn(c, upsertUser(db, "dev", email, email, String(f.name ?? "").trim() || null));
  });

  app.post("/auth/logout", (c) => {
    deleteSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  app.get("/login", (c) => (sessionUser(db, getCookie(c, SESSION_COOKIE)) ? c.redirect("/") : loginPage(c)));

  // --- Consultation libre, modifications après connexion -------------------------------------
  // Les compétitions, manches et classements se consultent sans compte ; créer ou modifier demande d'être connecté.
  // Programmes : clé d'API dans l'en-tête « Authorization: Bearer pgs_… », à la place du cookie de session.
  const needsLogin = (c: Context<Env>) => c.req.method !== "GET" || /\/(edit|new)$/.test(c.req.path) || c.req.path === "/account";
  app.use("*", async (c, next) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const user = bearer ? apiTokenUser(db, bearer) : (sessionUser(db, getCookie(c, SESSION_COOKIE)) ?? null);
    if (bearer && !user) return c.json({ error: t("Clé d'API inconnue ou supprimée.") }, 401);
    if (!user && needsLogin(c)) return c.req.path.startsWith("/api/") ? c.json({ error: t("Connexion requise : clé d'API attendue.") }, 401) : c.redirect("/login");
    c.set("user", user);
    await next();
  });
  /** Utilisateur connecté, sur les routes qui l'exigent (garanti par le contrôle ci-dessus). */
  const me = (c: Context<Env>): User => c.get("user")!;

  // Tout utilisateur connecté voit toutes les compétitions ; seuls leur créateur et les administrateurs les modifient.
  const competition = (_c: Context<Env>, id: string): CompetitionRow | null => {
    const row = db.prepare("SELECT * FROM competitions WHERE id = ?").get(Number(id)) as unknown as CompetitionRow | undefined;
    return row ?? null;
  };
  const admins = new Set((cfg.adminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const isAdmin = (u: User) => Boolean(u.email && admins.has(u.email.toLowerCase()));
  const canEdit = (c: Context<Env>, comp: CompetitionRow) => {
    const u = c.get("user");
    return Boolean(u && (comp.owner_id === u.id || isAdmin(u)));
  };
  // Garde d'écriture : toute requête autre que GET (réglages, traces, calcul, officialisation, classements…)
  // et les pages d'édition demandent le droit de modifier la compétition concernée.
  const writes = (c: Context<Env>) => c.req.method !== "GET" || /\/(edit|tasks\/new)$/.test(c.req.path);
  const guard = (load: (c: Context<Env>) => CompetitionRow | null) => async (c: Context<Env>, next: () => Promise<void>) => {
    if (writes(c)) {
      const comp = load(c);
      if (comp && !canEdit(c, comp)) {
        if (c.req.method === "GET") return c.redirect(c.req.path.replace(/\/(edit|tasks\/new)$/, ""));
        return c.text(t("Vous ne pouvez pas modifier cette compétition."), 403);
      }
    }
    await next();
  };
  const compOfTask = (c: Context<Env>) => {
    const row = db.prepare("SELECT competition_id FROM tasks WHERE id = ?").get(Number(c.req.param("id"))) as unknown as { competition_id: number } | undefined;
    return row ? competition(c, String(row.competition_id)) : null;
  };
  const compGuard = guard((c) => (/^\d+$/.test(c.req.param("id") ?? "") ? competition(c, c.req.param("id")!) : null));
  app.use("/competitions/:id", compGuard);
  app.use("/competitions/:id/*", compGuard);
  app.use("/tasks/:id", guard(compOfTask));
  app.use("/tasks/:id/*", guard(compOfTask));
  const taskOf = (c: Context<Env>, id: string): { t: TaskRow; comp: CompetitionRow } | null => {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(id)) as unknown as TaskRow | undefined;
    const comp = t ? competition(c, String(t.competition_id)) : null;
    return t && comp ? { t, comp } : null;
  };
  const notFound = (c: Context<Env>) => c.html(<NotFound user={c.get("user")} />, 404);

  app.get("/", (c) => {
    // Dernier calcul terminé de chaque compétition : l'accueil montre d'abord les plus récemment calculées.
    const rows = db
      .prepare(
        `SELECT c.*, u.name AS owner_name, u.email AS owner_email,
                (SELECT MAX(r.finished_at) FROM runs r JOIN tasks tk ON tk.id = r.task_id WHERE tk.competition_id = c.id AND r.status = 'done') AS scored_at
           FROM competitions c JOIN users u ON u.id = c.owner_id
          ORDER BY COALESCE(c.start_date, '') DESC, c.id DESC`,
      )
      .all() as unknown as Array<CompetitionRow & { owner_name: string | null; owner_email: string | null; scored_at: number | null }>;
    const user = c.get("user");
    const recent = rows
      .filter((r) => r.scored_at && r.owner_id !== user?.id)
      .sort((a, b) => b.scored_at! - a.scored_at!)
      .slice(0, 30)
      .map((r) => ({ ...r, owner: r.owner_name || "", scoredAt: r.scored_at! }));
    return c.html(<HomePage user={user} mine={user ? rows.filter((r) => r.owner_id === user.id) : []} recent={recent} error={c.req.query("error") ?? null} notice={c.req.query("msg") ?? null} />);
  });

  // --- Clés d'API (page « Mon compte ») ------------------------------------------------------
  const accountPage = (c: Context<Env>, extra: { token?: string; error?: string } = {}) =>
    c.html(<AccountPage user={me(c)} tokens={listApiTokens(db, me(c).id)} baseUrl={cfg.baseUrl} token={extra.token ?? null} error={extra.error ?? null} />, extra.error ? 400 : 200);
  app.get("/account", (c) => accountPage(c));
  app.post("/account/tokens", async (c) => {
    const f = await c.req.parseBody();
    const name = String(f.name ?? "").trim();
    if (!name) return accountPage(c, { error: t("Donnez un nom à la clé (par exemple le programme qui l'utilise).") });
    return accountPage(c, { token: createApiToken(db, me(c).id, name.slice(0, 80)) });
  });
  app.post("/account/tokens/:tid/delete", (c) => {
    deleteApiToken(db, me(c).id, Number(c.req.param("tid")));
    return c.redirect("/account");
  });
  app.get("/about", (c) => c.html(<AboutPage user={c.get("user")} />));
  app.get("/api", (c) => c.html(<ApiDocPage user={c.get("user")} baseUrl={cfg.baseUrl} />));

  // --- API : liste, export et import de compétitions ---------------------------------------------
  const MAX_IMPORT = 1024 * 1024 * 1024;
  const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "competition";
  const scoredAt = db.prepare(
    "SELECT MAX(r.finished_at) AS at FROM runs r JOIN tasks tk ON tk.id = r.task_id WHERE tk.competition_id = ? AND r.status = 'done'",
  );
  app.get("/api/competitions", (c) => {
    const rows = db.prepare("SELECT * FROM competitions ORDER BY COALESCE(start_date, '') DESC, id DESC").all() as unknown as CompetitionRow[];
    const user = c.get("user");
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        location: r.location,
        start_date: r.start_date,
        end_date: r.end_date,
        url: `${cfg.baseUrl}/competitions/${r.id}`,
        export: `${cfg.baseUrl}/api/competitions/${r.id}/export`,
        scored_at: (scoredAt.get(r.id) as { at: number | null }).at,
        editable: canEdit(c, r),
        mine: r.owner_id === user?.id,
      })),
    );
  });
  app.get("/api/competitions/:id/export", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return c.json({ error: t("Compétition introuvable.") }, 404);
    const withTracks = c.req.query("tracks") !== "0";
    const zip = exportCompetition(db, tracks, comp, { tracks: withTracks });
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${slug(comp.name)}${withTracks ? "" : "-sans-traces"}.pgscore.zip"`,
    });
  });
  app.get("/api/competitions/:id/fsdb", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return c.json({ error: t("Compétition introuvable.") }, 404);
    return c.body(competitionFsdb(db, comp), 200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${slug(comp.name)}.fsdb"`,
    });
  });
  app.get("/api/competitions/:id/fsdb.zip", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return c.json({ error: t("Compétition introuvable.") }, 404);
    const zip = competitionFsdbZip(db, tracks, comp, `${slug(comp.name)}.fsdb`);
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${slug(comp.name)}.fsdb.zip"`,
    });
  });
  /** Import d'une archive pgscore ou d'un fichier FSDB, reconnu à son contenu. */
  const importAny = (userId: number, bytes: Uint8Array) => {
    if (!looksLikeFsdb(bytes)) return importCompetition(db, tracks, userId, bytes);
    const { a, files, warnings } = fsdbToArchive(bytes);
    const r = writeArchive(db, tracks, userId, a, files);
    return { ...r, warnings: [...warnings, ...(r.warnings ?? [])] };
  };
  const readImport = async (c: Context<Env>): Promise<Uint8Array> => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_IMPORT) throw new FormError(t("Archive trop grosse (1 Go au plus)."));
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
      const f = await c.req.parseBody();
      if (!(f.file instanceof File) || !f.file.size) throw new FormError(t("Choisissez l'archive de la compétition."));
      return new Uint8Array(await f.file.arrayBuffer());
    }
    return new Uint8Array(await c.req.arrayBuffer());
  };
  app.post("/api/competitions/import", async (c) => {
    try {
      const r = importAny(me(c).id, await readImport(c));
      return c.json({ ...r, url: `${cfg.baseUrl}/competitions/${r.id}` }, 201);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return c.json({ error: e.message }, 400);
    }
  });
  // Même import depuis la page d'accueil (formulaire).
  app.post("/competitions/import", async (c) => {
    try {
      const r = importAny(me(c).id, await readImport(c));
      const msg = [
        t("Compétition importée : {tasks} manches, {pilots} pilotes, {tracks} traces.", { tasks: r.tasks, pilots: r.pilots, tracks: r.tracks }),
        r.missingTracks ? t("{n} traces sans fichier dans l'archive n'ont pas été reprises.", { n: r.missingTracks }) : "",
        ...(r.warnings ?? []),
      ]
        .filter(Boolean)
        .join(" ");
      return c.redirect(`/competitions/${r.id}?msg=${encodeURIComponent(msg)}`);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return c.redirect(`/competitions/new?error=${encodeURIComponent(e.message)}`);
    }
  });

  // Suppression définitive d'une compétition : super-administrateurs seulement, nom à recopier.
  app.post("/competitions/:id/delete", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const user = me(c);
    if (!isAdmin(user)) return c.text(t("Seul un administrateur peut supprimer une compétition."), 403);
    const f = await c.req.parseBody();
    if (String(f.confirm ?? "").trim() !== comp.name.trim())
      return c.redirect(`/competitions/${comp.id}/edit?error=${encodeURIComponent(t("Recopiez exactement le nom de la compétition pour la supprimer."))}#delete`);
    db.prepare("DELETE FROM competitions WHERE id = ?").run(comp.id);
    console.log(`Compétition ${comp.id} « ${comp.name} » supprimée par ${user.email ?? user.id}`);
    return c.redirect(`/?msg=${encodeURIComponent(t("Compétition « {name} » supprimée.", { name: comp.name }))}`);
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
      throw new FormError(t("Fichier OpenAir illisible : {error}", { error: (e as Error).message }));
    }
    if (!count) throw new FormError(t("Aucune zone trouvée dans le fichier OpenAir."));
    return { name: file.name, text, count };
  };

  app.get("/competitions/new", (c) =>
    c.html(<NewCompetitionPage user={c.get("user")} v={{ name: "", location: "", start_date: "", end_date: "", settings: DEFAULT_SETTINGS }} error={c.req.query("error") ?? null} />),
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
          me(c).id,
          name,
          String(f.location ?? "").trim() || null,
          String(f.start_date ?? "") || null,
          String(f.end_date ?? "") || null,
          JSON.stringify(settings),
          air?.name ?? null,
          air?.text ?? null,
          Date.now(),
        );
      addDefaultRankings(db, Number(r.lastInsertRowid));
      return c.redirect(`/competitions/${r.lastInsertRowid}`);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return c.html(<NewCompetitionPage user={c.get("user")} v={formValues(f)} error={e.message} />, 400);
    }
  });

  const competitionPage = (
    c: Context<Env>,
    comp: CompetitionRow,
    extra: { error?: string; notice?: string; v?: CompetitionFormValues; edit?: boolean; board?: BoardQuery } = {},
  ) => {
    const bq = extra.board ?? {};
    const x = standingsOf(comp, bq.rid);
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
        board={{
          s: x.s,
          pilots: x.pilots,
          rankings: x.rankings.map((r) => ({ r, count: x.members.get(r.row.id)!.size })),
          current: x.current,
          create: Boolean(bq.create) && canEdit(c, comp),
          canEdit: canEdit(c, comp),
          all: Boolean(bq.all),
          error: bq.error ?? null,
          notice: bq.notice ?? null,
        }}
        pilots={x.pilots}
        airspaceCount={count}
        error={extra.error ?? null}
        notice={extra.notice ?? null}
        edit={extra.edit ?? false}
        canEdit={canEdit(c, comp)}
        canDelete={Boolean(c.get("user") && isAdmin(c.get("user")!))}
      />,
      extra.error || bq.error ? 400 : 200,
    );
  };

  /** Vue du classement demandée dans l'adresse de la page de la compétition. */
  type BoardQuery = { rid?: string; create?: boolean; all?: boolean; error?: string; notice?: string };
  const boardQuery = (c: Context<Env>): BoardQuery => ({
    rid: c.req.query("r"),
    create: c.req.query("new") === "1",
    all: c.req.query("all") === "1",
    notice: c.req.query("note"),
  });

  // Onglet « Éditer » : réglages de la compétition, espace aérien et pilotes.
  app.get("/competitions/:id/edit", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const msg = c.req.query("msg");
    const error = c.req.query("error");
    return competitionPage(c, comp, { edit: true, ...(error ? { error } : {}), ...(msg ? { notice: msg } : c.req.query("ok") ? { notice: t("Enregistré.") } : {}) });
  });

  app.get("/competitions/:id", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const msg = c.req.query("msg");
    const board = boardQuery(c);
    if (board.rid && !standingsOf(comp, board.rid).current) return notFound(c);
    return competitionPage(c, comp, { board, ...(msg ? { notice: msg } : c.req.query("ok") ? { notice: t("Enregistré.") } : {}) });
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
      return c.redirect(`/competitions/${comp.id}/edit?ok=1#settings`);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return competitionPage(c, comp, { edit: true, error: e.message, v: formValues(f, parseSettings(comp.params)) });
    }
  });

  // --- Pilotes inscrits -------------------------------------------------------------------
  /** Singulier pour 1 (et 0 en français, comme « 0 pilote ajouté »). */
  const one = (n: number) => n === 1 || (n === 0 && lang() === "fr");
  const backToPilots = (c: Context<Env>, comp: CompetitionRow, msg: string) =>
    c.redirect(`/competitions/${comp.id}/edit?msg=${encodeURIComponent(msg)}#pilots`);

  app.post("/competitions/:id/pilots/import", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    try {
      if (!(f.file instanceof File) || !f.file.size) throw new FormError(t("Choisissez un fichier FSDB ou CSV."));
      const list = pilotsFromFile(f.file.name, decodeText(new Uint8Array(await f.file.arrayBuffer())));
      const r = upsertPilots(db, comp.id, list);
      const p = { added: r.added, updated: r.updated };
      return backToPilots(
        c,
        comp,
        one(r.added) ? t("Import : {added} pilote ajouté, {updated} mis à jour.", p) : t("Import : {added} pilotes ajoutés, {updated} mis à jour.", p),
      );
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return competitionPage(c, comp, { edit: true, error: e.message });
    }
  });

  app.post("/competitions/:id/pilots", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    try {
      const r = savePilotTable(db, comp.id, f);
      const n = r.removed;
      const msg = !n
        ? r.added
          ? t("Pilotes enregistrés : pilote ajouté.")
          : t("Pilotes enregistrés.")
        : r.added
          ? one(n)
            ? t("Pilotes enregistrés : pilote ajouté, {n} pilote retiré.", { n })
            : t("Pilotes enregistrés : pilote ajouté, {n} pilotes retirés.", { n })
          : one(n)
            ? t("Pilotes enregistrés : {n} pilote retiré.", { n })
            : t("Pilotes enregistrés : {n} pilotes retirés.", { n });
      return backToPilots(c, comp, msg);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return competitionPage(c, comp, { edit: true, error: e.message });
    }
  });

  app.get("/competitions/:id/pilots.csv", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    return c.body(pilotsCsv(listPilots(db, comp.id)), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pilotes.csv"`,
    });
  });

  /** Classement affiché : le général, ou un classement extrait (?r=id). */
  const standingsOf = (comp: CompetitionRow, rid: string | undefined) => {
    const all = competitionStandings(db, comp);
    const pilots = listPilots(db, comp.id);
    const rankings = listRankings(db, comp.id);
    const members = new Map(rankings.map((r) => [r.row.id, rankingMembers(r, pilots)]));
    const current = rid ? (rankings.find((r) => r.row.id === Number(rid)) ?? null) : null;
    const s = current ? extractStandings(all, members.get(current.row.id)!) : all;
    return { all, s, pilots, rankings, members, current };
  };

  /** Erreur d'un formulaire de classement : la page de la compétition, classement ouvert. */
  const standingsPage = (c: Context<Env>, comp: CompetitionRow, rid: string | undefined, extra: { error?: string; create?: boolean } = {}) =>
    competitionPage(c, comp, { board: { rid, create: extra.create, error: extra.error } });

  // Ancienne page des classements : tout est maintenant sur la page de la compétition.
  app.get("/competitions/:id/standings", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const r = c.req.query("r");
    return c.redirect(boardUrl(comp, { r: r ? Number(r) : null, all: true, create: c.req.query("new") === "1" }));
  });

  app.get("/competitions/:id/standings.csv", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const x = standingsOf(comp, c.req.query("r"));
    if (c.req.query("r") && !x.current) return notFound(c);
    const slug = x.current ? x.current.row.name.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() : "general";
    return c.body(standingsCsv(x.s), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="classement-${slug}.csv"`,
    });
  });

  // --- Classements extraits --------------------------------------------------------------
  const toRanking = (comp: CompetitionRow, rid: number, msg?: string) =>
    boardUrl(comp, { r: rid }).replace("#", msg ? `&note=${encodeURIComponent(msg)}#` : "#");

  app.post("/competitions/:id/rankings", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    try {
      return c.redirect(toRanking(comp, createRanking(db, comp.id, f), t("Classement créé.")));
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return standingsPage(c, comp, undefined, { error: e.message, create: true });
    }
  });

  app.post("/competitions/:id/rankings/:rid", async (c) => {
    const comp = competition(c, c.req.param("id"));
    const r = comp ? getRanking(db, comp.id, Number(c.req.param("rid"))) : null;
    if (!comp || !r) return notFound(c);
    const f = await c.req.parseBody();
    try {
      updateRanking(db, r, f);
      return c.redirect(toRanking(comp, r.row.id, t("Classement enregistré.")));
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return standingsPage(c, comp, String(r.row.id), { error: e.message });
    }
  });

  app.post("/competitions/:id/rankings/:rid/delete", (c) => {
    const comp = competition(c, c.req.param("id"));
    const r = comp ? getRanking(db, comp.id, Number(c.req.param("rid"))) : null;
    if (!comp || !r) return notFound(c);
    deleteRanking(db, r);
    return c.redirect(`/competitions/${comp.id}?note=${encodeURIComponent(t("Classement « {name} » supprimé.", { name: r.row.name }))}#standings`);
  });

  app.post("/competitions/:id/rankings/:rid/pilots", async (c) => {
    const comp = competition(c, c.req.param("id"));
    const r = comp ? getRanking(db, comp.id, Number(c.req.param("rid"))) : null;
    if (!comp || !r) return notFound(c);
    const f = await c.req.parseBody();
    const how = String(f.how ?? "");
    try {
      if (how !== "include" && how !== "exclude" && how !== "reset") throw new FormError(t("Action inconnue."));
      setOverride(db, r, String(f.pilot ?? ""), how);
      return c.redirect(toRanking(comp, r.row.id));
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return standingsPage(c, comp, String(r.row.id), { error: e.message });
    }
  });

  app.post("/competitions/:id/airspace", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    try {
      const air = await readAirspace(f.airspace);
      if (!air) throw new FormError(t("Choisissez un fichier OpenAir."));
      db.prepare("UPDATE competitions SET airspace_name = ?, airspace_text = ? WHERE id = ?").run(air.name, air.text, comp.id);
      return c.redirect(`/competitions/${comp.id}/edit?ok=1#airspace`);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return competitionPage(c, comp, { edit: true, error: e.message });
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
        if (!decoded) throw new FormError(t("Aucun QR code lisible dans l'image. Essayez une image plus nette ou collez le texte."));
        text = decoded;
      } else if (String(f.text ?? "").trim()) {
        source = "qr-text";
        text = String(f.text).trim();
      } else throw new FormError(t("Envoyez un fichier .xctsk, une image du QR code ou son texte."));
      let task: Task;
      try {
        task = parseXctsk(text.trim());
        taskDistances(task);
      } catch (e) {
        throw new FormError(t("Manche illisible : {error}", { error: (e as Error).message }));
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

  /** Classements extraits de la compétition, et les pilotes de celui demandé (?r=). */
  const taskRankings = (comp: CompetitionRow, rid: string | undefined) => {
    const rankings = listRankings(db, comp.id);
    const r = rid ? rankings.find((x) => x.row.id === Number(rid)) : undefined;
    return {
      list: rankings.map((x) => ({ id: x.row.id, name: x.row.name })),
      current: r ? { id: r.row.id, members: rankingMembers(r, listPilots(db, comp.id)) } : null,
    };
  };

  const taskPage = (c: Context<Env>, t: TaskRow, comp: CompetitionRow, extra: { error?: string; notice?: string; edit?: boolean } = {}) => {
    const rk = taskRankings(comp, c.req.query("r"));
    const task = JSON.parse(t.task) as Task;
    const tracks = db
      .prepare("SELECT * FROM tracks WHERE task_id = ? ORDER BY CAST(pilot_key AS INTEGER), pilot_key")
      .all(t.id) as unknown as TrackRow[];
    const run = (db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(t.id) as unknown as RunRow | undefined) ?? null;
    return c.html(
      <TaskPage
        openTracks={c.req.query("open") === "tracks"}
        user={c.get("user")}
        c={comp}
        t={t}
        task={task}
        settings={parseSettings(comp.params)}
        distances={taskDistances(task)}
        tracks={tracks}
        history={trackHistory(db, t.id)}
        decisions={listDecisions(db, t.id)}
        geometry={JSON.stringify(taskGeometry(task))}
        run={run}
        done={
          (db.prepare("SELECT * FROM runs WHERE task_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(t.id) as unknown as RunRow | undefined) ?? null
        }
        rankings={rk.list}
        ranking={rk.current}
        details={c.req.query("view") === "details"}
        registry={listPilots(db, comp.id)}
        running={isRunning(t.id) || run?.status === "running" || run?.status === "queued"}
        error={extra.error ?? null}
        notice={extra.notice ?? null}
        edit={extra.edit ?? Boolean(extra.error)}
        canEdit={canEdit(c, comp)}
      />,
      extra.error ? 400 : 200,
    );
  };

  /** Bloc « Calcul » seul, pour le mettre à jour sans recharger la page. */
  const runCard = (c: Context<Env>, t: TaskRow, comp: CompetitionRow) => {
    const fresh = db.prepare("SELECT * FROM tasks WHERE id = ?").get(t.id) as unknown as TaskRow;
    const run = (db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(t.id) as unknown as RunRow | undefined) ?? null;
    const counts = lastScoringChange(db, fresh);
    const lastChange = counts.changed;
    const running = isRunning(t.id) || run?.status === "running" || run?.status === "queued";
    return c.html(
      <RunCard t={fresh} run={run} running={running} settings={parseSettings(comp.params)} tracks={counts.tracks} stale={run !== null && lastChange > run.started_at} />,
      200,
      { "cache-control": "no-store" },
    );
  };

  // Onglet principal (carte et résultats) et onglet « Éditer » (réglages, traces, calcul, décisions).
  for (const [path, edit] of [["/tasks/:id", false], ["/tasks/:id/edit", true]] as const)
  app.get(path, (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const q = (k: string) => Number(c.req.query(k) ?? 0);
    // Une phrase par information.
    const added = q("added");
    const replaced = q("replaced");
    const same = q("same");
    const parts = [
      c.req.query("created") ? t("Manche créée : vérifiez le parcours sur la carte avant d'envoyer les traces.") : "",
      added ? (one(added) ? t("{n} trace ajoutée.", { n: added }) : t("{n} traces ajoutées.", { n: added })) : "",
      replaced ? (one(replaced) ? t("{n} trace remplacée.", { n: replaced }) : t("{n} traces remplacées.", { n: replaced })) : "",
      same
        ? one(same)
          ? t("{n} fichier identique à la trace en place, ignoré.", { n: same })
          : t("{n} fichiers identiques aux traces en place, ignorés.", { n: same })
        : "",
    ].filter(Boolean);
    return taskPage(c, x.t, x.comp, { edit, ...(parts.length ? { notice: parts.join(" ") } : {}) });
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
    if (JSON.stringify(task) !== x.t.task) touchScoring(db, x.t.id);
    return c.redirect(`/tasks/${x.t.id}/edit#task-settings`);
  });

  app.post("/tasks/:id/decisions", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    try {
      addDecision(db, x.t.id, me(c).id, await c.req.parseBody());
    } catch (e) {
      if (e instanceof FormError) return taskPage(c, x.t, x.comp, { error: e.message });
      throw e;
    }
    return c.redirect(`/tasks/${x.t.id}/edit#decisions`);
  });

  app.post("/tasks/:id/decisions/:did/delete", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    deleteDecision(db, x.t.id, Number(c.req.param("did")));
    return c.redirect(`/tasks/${x.t.id}/edit#decisions`);
  });

  app.post("/tasks/:id/tracks", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD) return taskPage(c, x.t, x.comp, { error: t("Envoi trop gros (200 Mo au plus).") });
    const f = await c.req.parseBody({ all: true });
    const list = ([] as unknown[]).concat(f.files ?? []).filter((v): v is File => v instanceof File && v.size > 0);
    let igcs;
    try {
      igcs = collectIgc(await Promise.all(list.map(async (v) => ({ name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) }))));
    } catch (e) {
      return taskPage(c, x.t, x.comp, { error: t("Archive illisible : {error}", { error: (e as Error).message }) });
    }
    if (!igcs.length) return taskPage(c, x.t, x.comp, { error: t("Aucun fichier IGC trouvé dans l'envoi.") });
    // Fichiers écrits sur disque avant la base : une ligne de la base pointe toujours vers un fichier présent.
    const stored = igcs.map((g) => ({ g, sha256: tracks.put(g.bytes) }));
    const count = { added: 0, replaced: 0, same: 0 };
    // Pilote de chaque trace : nom de fichier, sinon en-tête IGC rapproché des inscrits (traces anonymes).
    const registry = listPilots(db, x.comp.id);
    // Traces déjà dans la manche : une trace anonyme ne les remplace pas, elle prend une nouvelle clé.
    const existing = db.prepare("SELECT pilot_key, pilot_name, sha256 FROM tracks WHERE task_id = ?").all(x.t.id) as Array<{ pilot_key: string; pilot_name: string | null; sha256: string }>;
    const bySha = new Map(existing.map((e) => [e.sha256, e.pilot_key]));
    const used = new Map<string, string | null>(existing.map((e) => [e.pilot_key, e.pilot_name ? nameKey(e.pilot_name) : null]));
    const regName = new Map(registry.map((p) => [p.pilot_key, p.name]));
    db.exec("BEGIN");
    for (const { g, sha256 } of stored) {
      // Fichier déjà présent dans la manche : c'est la même trace, elle garde son pilote.
      const pilotKey = bySha.get(sha256) ?? pilotKeyForTrack(g.filename, g.text, registry, used);
      count[saveTrack(db, x.t.id, me(c).id, { pilotKey, pilotName: regName.get(pilotKey) ?? igcPilot(g.text), filename: g.filename, sha256, size: g.bytes.length })]++;
    }
    db.exec("COMMIT");
    return c.redirect(`/tasks/${x.t.id}/edit?${new URLSearchParams([...Object.entries(count).filter(([, n]) => n).map(([k, n]) => [k, String(n)]), ["open", "tracks"]])}#tracks`);
  });

  // Remplacer la trace d'un pilote donné, quel que soit le nom du nouveau fichier. Le pilote garde son
  // nom : l'en-tête du nouveau fichier peut porter un autre nom (instrument prêté).
  app.post("/tasks/:id/tracks/:trackId/replace", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const tr = db.prepare("SELECT * FROM tracks WHERE id = ? AND task_id = ?").get(Number(c.req.param("trackId")), x.t.id) as unknown as TrackRow | undefined;
    if (!tr) return notFound(c);
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD) return taskPage(c, x.t, x.comp, { error: t("Envoi trop gros (200 Mo au plus).") });
    const f = await c.req.parseBody();
    const file = f.file instanceof File && f.file.size > 0 ? f.file : null;
    if (!file) return taskPage(c, x.t, x.comp, { error: t("Choisissez le nouveau fichier IGC.") });
    let igcs;
    try {
      igcs = collectIgc([{ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }]);
    } catch (e) {
      return taskPage(c, x.t, x.comp, { error: t("Archive illisible : {error}", { error: (e as Error).message }) });
    }
    if (igcs.length !== 1) {
      return taskPage(c, x.t, x.comp, { error: igcs.length ? t("L'archive contient plusieurs traces : envoyez un seul fichier IGC.") : t("Ce fichier n'est pas une trace IGC.") });
    }
    const g = igcs[0]!;
    const note = typeof f.note === "string" && f.note.trim() ? f.note.trim().slice(0, 500) : null;
    const sha256 = tracks.put(g.bytes);
    const how = saveTrack(db, x.t.id, me(c).id, { pilotKey: tr.pilot_key, pilotName: tr.pilot_name ?? igcPilot(g.text), filename: g.filename, sha256, size: g.bytes.length, note });
    if (how === "same") return taskPage(c, x.t, x.comp, { edit: true, notice: t("Ce fichier est déjà la trace de {pilot} : rien n'a changé.", { pilot: tr.pilot_name ?? tr.pilot_key }) });
    return c.redirect(`/tasks/${x.t.id}/edit?replaced=1&open=tracks#tracks`);
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
    removeTrack(db, x.t.id, Number(c.req.param("trackId")), me(c).id);
    // La liste des traces reste dépliée : on enchaîne souvent plusieurs retraits.
    return c.redirect(`/tasks/${x.t.id}/edit?open=tracks#tracks`);
  });

  app.post("/tasks/:id/runs", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    // Depuis la page (fetch), le calcul démarre sans recharger : on renvoie seulement le bloc « Calcul ».
    const inPlace = c.req.header("x-requested-with") === "fetch";
    try {
      startRun(db, tracks, x.t.id, me(c).id);
    } catch (e) {
      if (inPlace) return c.json({ error: (e as Error).message }, 400);
      return taskPage(c, x.t, x.comp, { error: (e as Error).message });
    }
    if (inPlace) return runCard(c, x.t, x.comp);
    return c.redirect(`/tasks/${x.t.id}/edit#run-card`);
  });

  // Manche officielle ou non : ses résultats comptent au classement général.
  app.post("/tasks/:id/official", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const f = await c.req.parseBody();
    db.prepare("UPDATE tasks SET official = ? WHERE id = ?").run(f.official === "1" ? 1 : 0, x.t.id);
    if (c.req.header("x-requested-with") === "fetch") return c.body(null, 204);
    return c.redirect(f.back === "competition" ? `/competitions/${x.comp.id}#standings` : `/tasks/${x.t.id}`);
  });

  app.get("/tasks/:id/run-card", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    return runCard(c, x.t, x.comp);
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

  // QR code XCTrack de la manche, écrit depuis la manche enregistrée (celle qui est calculée).
  app.get("/tasks/:id/qr.svg", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const qr = qrcode(0, "L");
    qr.addData(taskToXctskQr(JSON.parse(x.t.task) as Task), "Byte");
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true });
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" });
  });
  app.get("/tasks/:id/qr.txt", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    return c.text(taskToXctskQr(JSON.parse(x.t.task) as Task));
  });
  app.get("/tasks/:id/results.csv", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const run = db.prepare("SELECT results FROM runs WHERE task_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(x.t.id) as
      | { results: string }
      | undefined;
    if (!run) return notFound(c);
    const scoring = JSON.parse(run.results) as TaskScoring;
    const rk = taskRankings(x.comp, c.req.query("r"));
    if (rk.current) scoring.pilots = scoring.pilots.filter((p) => rk.current!.members.has(p.id));
    const csv = resultsCsv(scoring, parseSettings(x.comp.params).timeZone);
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="manche-${x.t.number}.csv"`,
    });
  });

  app.notFound((c) => c.html(<NotFound />, 404));
  return app;
}
