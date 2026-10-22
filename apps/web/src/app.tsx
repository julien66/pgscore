import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { apiTokenUser, SESSION_COOKIE, sessionUser } from "./auth.js";
import type { CompetitionRow, Db, TaskRow, User } from "./db.js";
import type { TrackStore } from "./track-store.js";
import { clientScript, isLang, lang, LANG_COOKIE, pickLang, t, withLang } from "./i18n.js";
import { vendorFile } from "./vendor.js";
import { readFileSync } from "node:fs";
import { NotFound } from "./pages/layout.js";
import { authRoutes } from "./routes/auth.js";
import { homeRoutes } from "./routes/home.js";
import { apiRoutes } from "./routes/api.js";
import { competitionsRoutes } from "./routes/competitions.js";
import { tasksRoutes } from "./routes/tasks.js";
import type { AppConfig, Ctx, Env } from "./routes/context.js";
import { getCompetition, getTask } from "./repo.js";
import { MAX_FORM, uploadLimit } from "./routes/util.js";

export type { AppConfig };

/** Fonds de carte (basemaps.js), chargés en images par Leaflet et par Cesium. */
const TILES = "https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://*.tile.opentopomap.org https://server.arcgisonline.com";
const csp = (script: string) => [
  "default-src 'self'",
  `script-src ${script}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${TILES}`,
  `connect-src 'self' ${TILES}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");
const CSP = csp("'self'");
/** Visionneuse : Cesium (vue 3D) compile du WebAssembly, génère du code à la volée et lance ses workers depuis des blob:. */
const VIEWER_CSP = csp("'self' blob: 'wasm-unsafe-eval' 'unsafe-eval'");

export function createApp(db: Db, tracks: TrackStore, cfg: AppConfig) {
  const app = new Hono<Env>();

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

  // Taille des envois, vérifiée sur les octets reçus (y compris sans Content-Length, en envoi par morceaux).
  // Les envois de traces et les imports, qui ont leur propre message d'erreur, gardent leur contrôle sur
  // l'en-tête Content-Length.
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const own = uploadLimit(c.req.path);
    if (own && c.req.header("content-length") && !c.req.header("transfer-encoding")) return next();
    const maxSize = own ?? MAX_FORM;
    return bodyLimit({ maxSize, onError: (c) => c.text(t("Envoi trop gros ({n} Mo au plus).", { n: maxSize / 1024 / 1024 }), 413) })(c, next);
  });

  // En-têtes de sécurité : scripts et styles servis par l'appli seulement, fonds de carte autorisés en
  // images, pas d'affichage dans un cadre d'un autre site.
  app.use("*", async (c, next) => {
    await next();
    c.header("content-security-policy", /^\/tasks\/\d+\/pilots\//.test(c.req.path) ? VIEWER_CSP : CSP);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "strict-origin-when-cross-origin");
  });

  // Scripts de l'interface, lus au démarrage.
  const scripts = Object.fromEntries(
    ["common.js", "viewer.js", "run.js", "taskmap.js", "basemaps.js", "competition.js", "comp-runs.js"].map((f) => [f, readFileSync(new URL(`./static/${f}`, import.meta.url), "utf8")]),
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

  authRoutes(app, db, cfg);

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
    const row = getCompetition(db, Number(id));
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
    const row = getTask(db, Number(c.req.param("id")));
    return row ? competition(c, String(row.competition_id)) : null;
  };
  const compGuard = guard((c) => (/^\d+$/.test(c.req.param("id") ?? "") ? competition(c, c.req.param("id")!) : null));
  app.use("/competitions/:id", compGuard);
  app.use("/competitions/:id/*", compGuard);
  app.use("/tasks/:id", guard(compOfTask));
  app.use("/tasks/:id/*", guard(compOfTask));
  const taskOf = (c: Context<Env>, id: string): { t: TaskRow; comp: CompetitionRow } | null => {
    const t = getTask(db, Number(id));
    const comp = t ? competition(c, String(t.competition_id)) : null;
    return t && comp ? { t, comp } : null;
  };
  const notFound = (c: Context<Env>) => c.html(<NotFound user={c.get("user")} />, 404);

  const ctx: Ctx = { db, tracks, cfg, me, competition, isAdmin, canEdit, taskOf, notFound };
  homeRoutes(app, ctx);
  apiRoutes(app, ctx);
  competitionsRoutes(app, ctx);
  tasksRoutes(app, ctx);

  app.notFound((c) => c.html(<NotFound />, 404));
  return app;
}
