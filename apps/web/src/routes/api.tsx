import { type Context } from "hono";
import type { CompetitionRow, User } from "../db.js";
import { startRuns } from "../runner.js";
import { FormError } from "../settings.js";
import { t } from "../i18n.js";
import { exportCompetition, importCompetition, writeArchive } from "../archive.js";
import { competitionFsdb, competitionFsdbZip, fsdbToArchive, looksLikeFsdb } from "../fsdb.js";
import { civlToArchive } from "../civlcomps.js";
import type { App, Ctx, Env } from "./context.js";
import { queryAll } from "../repo.js";
import { MAX_IMPORT } from "./util.js";
import { saveUpload, TooLarge } from "../upload.js";

/** API : liste, export et import de compétitions, import civlcomps, suppression. */
export function apiRoutes(app: App, ctx: Ctx) {
  const { db, tracks, cfg, me, competition, isAdmin, canEdit, notFound } = ctx;
  // --- API : liste, export et import de compétitions ---------------------------------------------
  const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "competition";
  const scoredAt = db.prepare(
    "SELECT MAX(r.finished_at) AS at FROM runs r JOIN tasks tk ON tk.id = r.task_id WHERE tk.competition_id = ? AND r.status = 'done'",
  );
  app.get("/api/competitions", (c) => {
    const rows = queryAll<CompetitionRow>(db, "SELECT * FROM competitions ORDER BY COALESCE(start_date, '') DESC, id DESC");
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
    return c.body(zip, 200, {
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
    return c.body(zip, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${slug(comp.name)}.fsdb.zip"`,
    });
  });
  /** Import d'une archive pgscore ou d'un fichier FSDB, reconnu à son contenu (fichier sur disque). */
  const importAny = (userId: number, src: string) => {
    if (!looksLikeFsdb(src)) return importCompetition(db, tracks, userId, src);
    const { a, files, warnings } = fsdbToArchive(src, tracks);
    const r = writeArchive(db, tracks, userId, a, files);
    return { ...r, warnings: [...warnings, ...(r.warnings ?? [])] };
  };
  /** Archive envoyée (formulaire ou corps brut), écrite sur disque puis importée ; le fichier est ensuite effacé. */
  const importUpload = async (c: Context<Env>, userId: number) => {
    let up;
    try {
      up = await saveUpload(c, MAX_IMPORT);
    } catch (e) {
      if (e instanceof TooLarge) throw new FormError(t("Archive trop grosse (1 Go au plus)."));
      throw e;
    }
    try {
      const file = up.files.find((f) => f.field === "file" && f.size > 0);
      if (!file) throw new FormError(t("Choisissez l'archive de la compétition."));
      return importAny(userId, file.path);
    } finally {
      up.done();
    }
  };
  app.post("/api/competitions/import", async (c) => {
    try {
      const r = await importUpload(c, me(c).id);
      return c.json({ ...r, url: `${cfg.baseUrl}/competitions/${r.id}` }, 201);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return c.json({ error: e.message }, 400);
    }
  });
  /** Import depuis civlcomps.org : manches, pilotes, pénalités et traces lus sur la page de résultats. */
  const importCivl = async (user: User, url: string) => {
    if (!isAdmin(user)) throw new FormError(t("L'import depuis civlcomps.org est réservé aux administrateurs."));
    const userId = user.id;
    const { a, files, warnings } = await civlToArchive(url, undefined, tracks);
    const r = writeArchive(db, tracks, userId, a, files);
    return { ...r, warnings: [...warnings, ...(r.warnings ?? [])] };
  };
  app.post("/api/competitions/import-civl", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
      const r = await importCivl(me(c), String(body.url ?? ""));
      return c.json({ ...r, url: `${cfg.baseUrl}/competitions/${r.id}` }, 201);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return c.json({ error: e.message }, 400);
    }
  });
  // Même import depuis la page d'accueil (formulaire) : fichier, ou adresse civlcomps.org.
  app.post("/competitions/import", async (c) => {
    try {
      let r;
      if ((c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
        const f = await c.req.parseBody();
        r = await importCivl(me(c), String(f.civl_url ?? ""));
      } else r = await importUpload(c, me(c).id);
      // Les manches importées avec leurs traces sont calculées tout de suite, l'une après l'autre ;
      // la page de la compétition montre l'avancement.
      const taskIds = (db.prepare("SELECT id FROM tasks WHERE competition_id = ? ORDER BY number, id").all(r.id) as Array<{ id: number }>).map((x) => x.id);
      startRuns(db, tracks, taskIds, me(c).id);
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
}
