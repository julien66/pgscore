import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { TaskRow } from "../db.js";
import { t } from "../i18n.js";
import { getCompetition, queryAll, queryOne } from "../repo.js";
import { ingestKey, IngestError, MAX_INGEST, readItems, saveReports } from "../reports.js";
import type { App, Ctx, Env } from "./context.js";

/** Adresses du service externe : ni session ni clé d'API personnelle, une clé d'envoi de la compétition. */
export const isIngestPath = (path: string) => path === "/api/ingest" || path.startsWith("/api/ingest/");

/**
 * Envoi de données sur les manches par un service externe (bot Telegram de la compétition) :
 * « Authorization: Bearer pgsi_… », clé créée dans l'onglet « Éditer » de la compétition.
 */
export function ingestRoutes(app: App, ctx: Ctx) {
  const { db, cfg } = ctx;

  const auth = (c: Context<Env>) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const key = bearer ? ingestKey(db, bearer) : null;
    const comp = key ? getCompetition(db, key.competition_id) : undefined;
    return key && comp ? { key, comp } : null;
  };
  const denied = (c: Context<Env>) => {
    c.header("www-authenticate", 'Bearer realm="pgscore"');
    return c.json({ error: t("Clé d'envoi absente, inconnue ou supprimée.") }, 401);
  };

  // Vérification de la clé : compétition et manches qu'elle peut alimenter.
  app.get("/api/ingest", (c) => {
    const a = auth(c);
    if (!a) return denied(c);
    const tasks = queryAll<Pick<TaskRow, "id" | "number" | "date">>(db, "SELECT id, number, date FROM tasks WHERE competition_id = ? ORDER BY number, id", a.comp.id);
    return c.json({
      competition: { id: a.comp.id, name: a.comp.name, url: `${cfg.baseUrl}/competitions/${a.comp.id}` },
      tasks: tasks.map((x) => ({ number: x.number, date: x.date, url: `${cfg.baseUrl}/api/ingest/tasks/${x.number}` })),
    });
  });

  app.post(
    "/api/ingest/tasks/:number",
    bodyLimit({ maxSize: MAX_INGEST, onError: (c) => c.json({ error: t("Envoi trop gros ({n} Mo au plus).", { n: MAX_INGEST / 1024 / 1024 }) }, 413) }),
    async (c) => {
      const a = auth(c);
      if (!a) return denied(c);
      const number = Number(c.req.param("number"));
      const task = Number.isInteger(number)
        ? queryOne<{ id: number }>(db, "SELECT id FROM tasks WHERE competition_id = ? AND number = ? ORDER BY id LIMIT 1", a.comp.id, number)
        : undefined;
      if (!task) return c.json({ error: t("Manche {n} introuvable dans cette compétition.", { n: c.req.param("number") }) }, 404);
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: t("JSON illisible.") }, 400);
      }
      try {
        const items = saveReports(db, task.id, a.key.id, readItems(body));
        return c.json({ task: number, received: items.length, items }, 201);
      } catch (e) {
        if (e instanceof IngestError) return c.json({ error: e.message }, 400);
        throw e;
      }
    },
  );
}
