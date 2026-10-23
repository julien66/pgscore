import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CompetitionRow } from "../db.js";
import { t } from "../i18n.js";
import { queryAll } from "../repo.js";
import {
  assignReport,
  createIngestKey,
  deleteIngestKey,
  deleteReport,
  ingestKey,
  IngestError,
  listIngestKeys,
  MAX_INGEST,
  pendingReports,
  readItems,
  rematchPending,
  saveReports,
} from "../reports.js";
import { IngestAdminPage } from "../pages/ingest.js";
import type { App, Ctx, Env } from "./context.js";

/** Adresses du service externe : ni session ni clé d'API personnelle, une clé d'envoi du service. */
export const isIngestPath = (path: string) => path === "/api/ingest" || path.startsWith("/api/ingest/");

/**
 * Service externe global (bots Telegram des compétitions) : envoi de données sur les manches avec
 * « Authorization: Bearer pgsi_… », et page d'administration des clés et des éléments non rattachés.
 */
export function ingestRoutes(app: App, ctx: Ctx) {
  const { db, cfg, me, isAdmin, notFound } = ctx;

  const auth = (c: Context<Env>) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    return bearer ? ingestKey(db, bearer) : null;
  };
  const denied = (c: Context<Env>) => {
    c.header("www-authenticate", 'Bearer realm="pgscore"');
    return c.json({ error: t("Clé d'envoi absente, inconnue ou supprimée.") }, 401);
  };

  // Vérification de la clé, et compétitions connues (nom, dates, manches) pour aider le service à nommer l'événement.
  app.get("/api/ingest", (c) => {
    if (!auth(c)) return denied(c);
    const comps = queryAll<Pick<CompetitionRow, "id" | "name" | "location" | "start_date" | "end_date">>(
      db,
      "SELECT id, name, location, start_date, end_date FROM competitions ORDER BY COALESCE(start_date, '') DESC, id DESC",
    );
    const tasks = queryAll<{ competition_id: number; number: number; date: string | null }>(db, "SELECT competition_id, number, date FROM tasks ORDER BY number, id");
    return c.json({
      competitions: comps.map((x) => ({
        ...x,
        url: `${cfg.baseUrl}/competitions/${x.id}`,
        tasks: tasks.filter((tk) => tk.competition_id === x.id).map((tk) => ({ number: tk.number, date: tk.date })),
      })),
    });
  });

  app.post(
    "/api/ingest",
    bodyLimit({ maxSize: MAX_INGEST, onError: (c) => c.json({ error: t("Envoi trop gros ({n} Mo au plus).", { n: MAX_INGEST / 1024 / 1024 }) }, 413) }),
    async (c) => {
      const key = auth(c);
      if (!key) return denied(c);
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: t("JSON illisible.") }, 400);
      }
      try {
        const items = saveReports(db, key.id, readItems(body));
        const numbers = new Map(queryAll<{ id: number; number: number }>(db, "SELECT id, number FROM tasks").map((x) => [x.id, x.number]));
        return c.json(
          {
            received: items.length,
            items: items.map((x) => ({
              id: x.id,
              type: x.type,
              external_id: x.external_id,
              status: x.status,
              competition: x.competition_id,
              task: x.task_id === null ? null : (numbers.get(x.task_id) ?? null),
            })),
          },
          201,
        );
      } catch (e) {
        if (e instanceof IngestError) return c.json({ error: e.message }, 400);
        throw e;
      }
    },
  );

  // --- Administration : clés du service et éléments sans manche -------------------------------------
  const page = (c: Context<Env>, extra: { token?: string; error?: string; notice?: string } = {}) =>
    c.html(
      <IngestAdminPage
        user={me(c)}
        baseUrl={cfg.baseUrl}
        keys={listIngestKeys(db)}
        pending={pendingReports(db)}
        competitions={queryAll<{ id: number; name: string; start_date: string | null }>(db, "SELECT id, name, start_date FROM competitions ORDER BY COALESCE(start_date, '') DESC, id DESC")}
        token={extra.token ?? null}
        error={extra.error ?? null}
        notice={extra.notice ?? c.req.query("msg") ?? null}
      />,
      extra.error ? 400 : 200,
    );
  app.use("/admin/ingest", async (c, next) => (isAdmin(me(c)) ? next() : notFound(c)));
  app.use("/admin/ingest/*", async (c, next) => (isAdmin(me(c)) ? next() : notFound(c)));
  app.get("/admin/ingest", (c) => page(c));
  app.post("/admin/ingest/keys", async (c) => {
    const name = String((await c.req.parseBody()).name ?? "").trim();
    if (!name) return page(c, { error: t("Donnez un nom à la clé (par exemple le programme qui l'utilise).") });
    return page(c, { token: createIngestKey(db, me(c).id, name.slice(0, 80)) });
  });
  app.post("/admin/ingest/keys/:kid/delete", (c) => {
    deleteIngestKey(db, Number(c.req.param("kid")));
    return c.redirect("/admin/ingest");
  });
  app.post("/admin/ingest/rematch", (c) => {
    const n = rematchPending(db);
    return c.redirect(`/admin/ingest?msg=${encodeURIComponent(t("{n} éléments rattachés à une manche.", { n }))}`);
  });
  app.post("/admin/ingest/reports/:rid", async (c) => {
    const f = await c.req.parseBody();
    const comp = Number(f.competition) || null;
    const num = String(f.task ?? "").trim() ? Number(f.task) : null;
    try {
      assignReport(db, Number(c.req.param("rid")), comp, num !== null && Number.isInteger(num) ? num : null);
    } catch (e) {
      if (e instanceof IngestError) return page(c, { error: e.message });
      throw e;
    }
    return c.redirect("/admin/ingest");
  });
  app.post("/admin/ingest/reports/:rid/delete", (c) => {
    deleteReport(db, Number(c.req.param("rid")));
    return c.redirect("/admin/ingest");
  });
}
