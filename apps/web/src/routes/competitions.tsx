import { type Context } from "hono";
import { parseOpenAir } from "@pgscore/engine";
import type { CompetitionRow, TaskRow } from "../db.js";
import { decodeText } from "../files.js";
import { isRunning, startRuns } from "../runner.js";
import { linkTracks } from "../tracks.js";
import { touchScoring } from "../decisions.js";
import { DEFAULT_SETTINGS, FormError, parseSettings, settingsFromForm } from "../settings.js";
import { t } from "../i18n.js";
import { competitionStandings, extractStandings, standingsCsv, type StandingsView } from "../standings.js";
import { addDefaultRankings, createRanking, deleteRanking, getRanking, listRankings, rankingMembers, setOverride, updateRanking } from "../rankings.js";
import { listPilots, pilotsCsv, registerTrackPilots, trackPilots, pilotsFromFile, savePilotTable, upsertPilots } from "../pilots.js";
import { CompetitionPage, NewCompetitionPage, type CompetitionFormValues } from "../pages/competition.js";
import { boardUrl } from "../pages/standings.js";
import type { App, Ctx, Env } from "./context.js";
import { one } from "./util.js";
import { tasksOf } from "../repo.js";
import { createIngestKey, deleteIngestKey, listIngestKeys } from "../reports.js";

/** Compétitions : création, réglages, pilotes inscrits, classements et classements extraits. */
export function competitionsRoutes(app: App, ctx: Ctx) {
  const { db, tracks, cfg, me, competition, isAdmin, canEdit, notFound } = ctx;
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
    c.html(<NewCompetitionPage user={c.get("user")} civl={Boolean(c.get("user") && isAdmin(c.get("user")!))} v={{ name: "", location: "", start_date: "", end_date: "", settings: DEFAULT_SETTINGS }} error={c.req.query("error") ?? null} />),
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
      return c.html(<NewCompetitionPage user={c.get("user")} civl={Boolean(c.get("user") && isAdmin(c.get("user")!))} v={formValues(f)} error={e.message} />, 400);
    }
  });

  const competitionPage = (
    c: Context<Env>,
    comp: CompetitionRow,
    extra: { error?: string; notice?: string; v?: CompetitionFormValues; edit?: boolean; board?: BoardQuery; ingestToken?: string } = {},
  ) => {
    const bq = extra.board ?? {};
    const x = standingsOf(comp, bq.rid, bq.view);
    const tasks = tasksOf(db, comp.id);
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
        runs={(() => {
          const runs = latestRuns(comp.id);
          return runs.some((r) => r.status === "queued" || r.status === "running") ? runs : null;
        })()}
        board={{
          s: x.s,
          pilots: x.pilots,
          rankings: x.rankings.map((r) => ({ r, count: x.members.get(r.row.id)!.size })),
          current: x.current,
          members: x.current ? x.members.get(x.current.row.id) : undefined,
          create: Boolean(bq.create) && canEdit(c, comp),
          canEdit: canEdit(c, comp),
          all: Boolean(bq.all),
          error: bq.error ?? null,
          notice: bq.notice ?? null,
        }}
        pilots={x.pilots}
        trackPilots={trackPilots(db, comp.id)}
        airspaceCount={count}
        error={extra.error ?? null}
        notice={extra.notice ?? null}
        edit={extra.edit ?? false}
        canEdit={canEdit(c, comp)}
        canDelete={Boolean(c.get("user") && isAdmin(c.get("user")!))}
        {...(extra.edit && canEdit(c, comp) ? { ingest: { keys: listIngestKeys(db, comp.id), token: extra.ingestToken ?? null, baseUrl: cfg.baseUrl } } : {})}
      />,
      extra.error || bq.error ? 400 : 200,
    );
  };

  /** Vue du classement demandée dans l'adresse de la page de la compétition. */
  type BoardQuery = { rid?: string; view?: StandingsView; create?: boolean; all?: boolean; error?: string; notice?: string };
  /** Manche choisie dans les onglets du classement (?m=id), seule ou en cumul (&cum=1). */
  const viewQuery = (c: Context<Env>): StandingsView => {
    const m = Number(c.req.query("m"));
    return Number.isInteger(m) && m > 0 ? { task: m, cumulative: c.req.query("cum") === "1" } : {};
  };
  const boardQuery = (c: Context<Env>): BoardQuery => ({
    rid: c.req.query("r"),
    view: viewQuery(c),
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

  // Dernier calcul de chaque manche : relu par la page de la compétition pendant les calculs lancés après un import.
  const latestRuns = (compId: number) =>
    db
      .prepare(
        `SELECT t.id AS task_id, t.number, r.status, r.step, r.done, r.total, r.error FROM tasks t
         JOIN runs r ON r.id = (SELECT MAX(id) FROM runs WHERE task_id = t.id)
         WHERE t.competition_id = ? ORDER BY t.number, t.id`,
      )
      .all(compId) as Array<{ task_id: number; number: number; status: string; step: string | null; done: number; total: number; error: string | null }>;
  app.get("/competitions/:id/runs.json", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    return c.json(latestRuns(comp.id));
  });

  // Recalcul de toutes les manches (après un changement de réglage) : l'une après l'autre, avancement sur la page.
  app.post("/competitions/:id/runs", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const ids = (db.prepare("SELECT id FROM tasks WHERE competition_id = ? ORDER BY number, id").all(comp.id) as Array<{ id: number }>).map((x) => x.id);
    const started = startRuns(db, tracks, ids, me(c).id);
    if (!started.length && !ids.some((id) => isRunning(id))) return competitionPage(c, comp, { error: t("Aucune manche avec des traces à calculer.") });
    return c.redirect(`/competitions/${comp.id}`);
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
  /**
   * Après un changement de la liste des pilotes : les traces des manches qui n'étaient rattachées à
   * aucun inscrit le sont si leur numéro ou leur nom correspond maintenant. Rend le message complété.
   */
  const backToPilots = (c: Context<Env>, comp: CompetitionRow, msg: string) => {
    const registry = listPilots(db, comp.id);
    let n = 0;
    for (const { id } of db.prepare("SELECT id FROM tasks WHERE competition_id = ?").all(comp.id) as Array<{ id: number }>) {
      const k = linkTracks(db, tracks, id, me(c).id, registry);
      if (k) touchScoring(db, id);
      n += k;
    }
    // Traces d'inscrits d'office qui ont trouvé leur numéro : l'inscrit prend ce numéro.
    if (n) registerTrackPilots(db, comp.id);
    if (n) msg += " " + (one(n) ? t("{n} trace rattachée à un pilote inscrit.", { n }) : t("{n} traces rattachées à des pilotes inscrits.", { n }));
    return c.redirect(`/competitions/${comp.id}/edit?msg=${encodeURIComponent(msg)}#pilots`);
  };

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
      const a = r.added;
      const msg = [
        t("Pilotes enregistrés."),
        a ? (a === 1 ? t("{n} pilote ajouté.", { n: a }) : t("{n} pilotes ajoutés.", { n: a })) : "",
        n ? (one(n) ? t("{n} pilote retiré.", { n }) : t("{n} pilotes retirés.", { n })) : "",
      ]
        .filter(Boolean)
        .join(" ");
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
  const standingsOf = (comp: CompetitionRow, rid: string | undefined, view: StandingsView = {}) => {
    const all = competitionStandings(db, comp, view);
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
    const x = standingsOf(comp, c.req.query("r"), viewQuery(c));
    if (c.req.query("r") && !x.current) return notFound(c);
    const v = x.s.view;
    const slug =
      (x.current ? x.current.row.name.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() : "general") +
      (v ? `-${v.cumulative ? "apres-" : ""}m${v.task.t.number}` : "");
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

  // Clés d'envoi du service externe (bot Telegram) : retours des pilotes et incidents, par manche.
  app.post("/competitions/:id/ingest-keys", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    const name = String(f.name ?? "").trim();
    if (!name) return competitionPage(c, comp, { edit: true, error: t("Donnez un nom à la clé (par exemple le programme qui l'utilise).") });
    return competitionPage(c, comp, { edit: true, ingestToken: createIngestKey(db, comp.id, me(c).id, name.slice(0, 80)) });
  });
  app.post("/competitions/:id/ingest-keys/:kid/delete", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    deleteIngestKey(db, comp.id, Number(c.req.param("kid")));
    return c.redirect(`/competitions/${comp.id}/edit#ingest`);
  });
}
