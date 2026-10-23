import { type Context } from "hono";
import { DifferencesPage } from "../differences.js";
import { createApiToken, deleteApiToken, listApiTokens } from "../auth.js";
import type { CompetitionRow } from "../db.js";
import { t } from "../i18n.js";
import { competitionSummaries, competitionWinners } from "../standings.js";
import { AccountPage, ApiDocPage, AboutPage } from "../pages/account.js";
import { HomePage } from "../pages/home.js";
import type { App, Ctx, Env } from "./context.js";
import { queryAll } from "../repo.js";

/** Accueil, compte (clés d'API), pages À propos, Différences et documentation de l'API. */
export function homeRoutes(app: App, ctx: Ctx) {
  const { db, cfg, me, isAdmin } = ctx;
  app.get("/", (c) => {
    // Dernier calcul terminé de chaque compétition : l'accueil montre d'abord les plus récemment calculées.
    const rows = queryAll<CompetitionRow & { owner_name: string | null; owner_email: string | null; scored_at: number | null }>(
      db,
      `SELECT c.*, u.name AS owner_name, u.email AS owner_email,
                (SELECT MAX(r.finished_at) FROM runs r JOIN tasks tk ON tk.id = r.task_id WHERE tk.competition_id = c.id AND r.status = 'done') AS scored_at
           FROM competitions c JOIN users u ON u.id = c.owner_id
          ORDER BY COALESCE(c.start_date, '') DESC, c.id DESC`,
    );
    const user = c.get("user");
    // Chiffres de chaque compétition, et vainqueur du général une fois terminée.
    const sums = competitionSummaries(db);
    const detail = <T extends CompetitionRow>(r: T) => ({ ...r, summary: sums.get(r.id), winners: competitionWinners(db, r) });
    const recent = rows
      .filter((r) => r.scored_at && r.owner_id !== user?.id)
      .sort((a, b) => b.scored_at! - a.scored_at!)
      .slice(0, 30)
      .map((r) => detail({ ...r, owner: r.owner_name || "", scoredAt: r.scored_at! }));
    return c.html(<HomePage user={user} mine={user ? rows.filter((r) => r.owner_id === user.id).map(detail) : []} recent={recent} error={c.req.query("error") ?? null} notice={c.req.query("msg") ?? null} />);
  });

  // --- Clés d'API (page « Mon compte ») ------------------------------------------------------
  const accountPage = (c: Context<Env>, extra: { token?: string; error?: string } = {}) =>
    c.html(<AccountPage user={me(c)} tokens={listApiTokens(db, me(c).id)} baseUrl={cfg.baseUrl} token={extra.token ?? null} error={extra.error ?? null} admin={isAdmin(me(c))} />, extra.error ? 400 : 200);
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
  app.get("/differences", (c) => c.html(<DifferencesPage user={c.get("user")} />));
  app.get("/api", (c) => c.html(<ApiDocPage user={c.get("user")} baseUrl={cfg.baseUrl} />));
}
