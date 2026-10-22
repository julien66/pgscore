import { type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createSession, deleteSession, GOOGLE_ISSUER, handleCallback, loginUrl, SESSION_COOKIE, sessionUser, upsertUser, type OidcConfig } from "../auth.js";
import type { User } from "../db.js";
import { t } from "../i18n.js";
import { LoginPage } from "../pages/account.js";
import type { App, AppConfig } from "./context.js";
import type { Db } from "../db.js";

/** Connexion : Google (OIDC), connexion de développement, déconnexion. */
export function authRoutes(app: App, db: Db, cfg: AppConfig) {
  const oidc: OidcConfig | null = cfg.google
    ? { provider: "google", issuer: GOOGLE_ISSUER, clientId: cfg.google.clientId, clientSecret: cfg.google.clientSecret, baseUrl: cfg.baseUrl }
    : null;

  const signIn = (c: Context, user: User) => {
    const s = createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "Lax", secure: cfg.secureCookies ?? false, path: "/", maxAge: s.maxAge });
    return c.redirect("/");
  };

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
}
