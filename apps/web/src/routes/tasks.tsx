import { type Context } from "hono";
import { parseXctsk, taskDistances, taskToXctskQr, type Task } from "@pgscore/engine";
import qrcode from "qrcode-generator";
import type { CompetitionRow, RunRow, TaskRow, TrackRow } from "../db.js";
import { collectIgc, decodeQrImage, decodeText, isPlaceholderPilot, filenamePilotName, learnFilenameConvention, nameKey, pilotKeyForTrack } from "../files.js";
import { isRunning, startRun } from "../runner.js";
import { assignTrack, linkTracks, pilotVersions, removeAllTracks, removeTrack, replaceTrack, saveTrack, taskHasFile, trackHistory } from "../tracks.js";
import { addDecision, addEmptyTrackDnf, clearEmptyTrackDnf, deleteDecision, isEmptyIgc, listDecisions, touchScoring } from "../decisions.js";
import { controlTask, FormError, parseSettings, taskScoringFromForm, type StoredTask } from "../settings.js";
import { localHmsToUtc } from "../time.js";
import { t } from "../i18n.js";
import { lastScoringChange } from "../standings.js";
import { listRankings, rankingMembers } from "../rankings.js";
import { listPilots, registerTrackPilots } from "../pilots.js";
import { taskGeometry, viewerData } from "../viewer-data.js";
import { GOAL_LINE_LENGTH } from "../civlcomps.js";
import { goalAltitudeOf } from "../pages/parts.js";
import { publishedPilots, resultsCsv, RunCard } from "../pages/results.js";
import { NewTaskPage, TaskPage } from "../pages/task.js";
import { ViewerPage } from "../pages/viewer.js";
import type { TaskScoring } from "@pgscore/engine";
import type { App, Ctx, Env } from "./context.js";
import { one } from "./util.js";
import { getTask, getTrack, latestDoneRun, latestRun, tracksOf } from "../repo.js";

const MAX_UPLOAD = 200 * 1024 * 1024;

/** Nom du pilote dans l'en-tête IGC (HFPLT). */
const igcPilot = (text: string) => /^HF[A-Z]{0,3}PLT[^:]*:(.*)$/im.exec(text)?.[1]?.trim() || null;

/** Manches : création, réglages, traces, calcul, décisions, résultats et visionneuse. */
export function tasksRoutes(app: App, ctx: Ctx) {
  const { db, tracks, me, competition, canEdit, taskOf, notFound } = ctx;
  // --- Manches -----------------------------------------------------------------------------
  app.get("/competitions/:id/tasks/new", (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const n = (db.prepare("SELECT COALESCE(MAX(number), 0) + 1 n FROM tasks WHERE competition_id = ?").get(comp.id) as { n: number }).n;
    return c.html(<NewTaskPage user={c.get("user")} c={comp} number={n} />);
  });

  /** Définition de la manche envoyée par formulaire : fichier .xctsk, image du QR code ou son texte. */
  const readTaskDefinition = async (f: Record<string, unknown>): Promise<{ source: string; text: string; task: Task }> => {
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
    return { source, text, task };
  };

  app.post("/competitions/:id/tasks", async (c) => {
    const comp = competition(c, c.req.param("id"));
    if (!comp) return notFound(c);
    const f = await c.req.parseBody();
    const number = Number(f.number) || 1;
    const date = String(f.date ?? "") || null;
    try {
      const { source, text, task } = await readTaskDefinition(f);
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
    const tracks = tracksOf(db, t.id);
    const run = latestRun(db, t.id);
    return c.html(
      <TaskPage
        openTracks={c.req.query("open") === "tracks"}
        user={c.get("user")}
        c={comp}
        t={t}
        task={task}
        settings={parseSettings(comp.params)}
        distances={taskDistances(controlTask(task, parseSettings(comp.params)))}
        tracks={tracks}
        history={trackHistory(db, t.id)}
        decisions={listDecisions(db, t.id)}
        geometry={JSON.stringify(taskGeometry(controlTask(task, parseSettings(comp.params))))}
        run={run}
        done={
          latestDoneRun(db, t.id)
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
        siblings={db.prepare("SELECT id, number, date FROM tasks WHERE competition_id = ? ORDER BY number, id").all(comp.id) as Array<{ id: number; number: number; date: string | null }>}
      />,
      extra.error ? 400 : 200,
    );
  };

  /** Bloc « Calcul » seul, pour le mettre à jour sans recharger la page. */
  const runCard = (c: Context<Env>, t: TaskRow, comp: CompetitionRow) => {
    const fresh = getTask(db, t.id)!;
    const run = latestRun(db, t.id);
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
    const extra = q("extra");
    const linked = q("linked");
    const dnf = q("dnf");
    const parts = [
      c.req.query("created") ? t("Manche créée : vérifiez le parcours sur la carte avant d'envoyer les traces.") : "",
      added ? (one(added) ? t("{n} trace ajoutée.", { n: added }) : t("{n} traces ajoutées.", { n: added })) : "",
      extra
        ? one(extra)
          ? t("{n} trace en plus pour un pilote qui en avait déjà une : les deux sont gardées, le calcul retient la plus favorable au pilote.", { n: extra })
          : t("{n} traces en plus pour des pilotes qui en avaient déjà une : elles sont gardées, le calcul retient la plus favorable à chaque pilote.", { n: extra })
        : "",
      dnf
        ? one(dnf)
          ? t("{n} fichier vide : pilote marqué DNF (n'a pas volé). Supprimez la décision s'il a volé.", { n: dnf })
          : t("{n} fichiers vides : pilotes marqués DNF (n'ont pas volé). Supprimez la décision de ceux qui ont volé.", { n: dnf })
        : "",
      replaced ? (one(replaced) ? t("{n} trace remplacée.", { n: replaced }) : t("{n} traces remplacées.", { n: replaced })) : "",
      c.req.query("linked") !== undefined
        ? linked
          ? one(linked)
            ? t("{n} trace rattachée à un pilote inscrit.", { n: linked })
            : t("{n} traces rattachées à des pilotes inscrits.", { n: linked })
          : t("Aucune trace de plus n'a pu être rattachée : choisissez le pilote sur la ligne de la trace.")
        : "",
      c.req.query("assigned") ? t("Trace rattachée au pilote.") : "",
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
      if (f.type === "race" || f.type === "time-trial") task.type = f.type;
      // Goal : une ligne fait 200 m de large (demi-cercle derrière) ; un cylindre fait 200 m de rayon ou plus.
      const goal = task.turnpoints.at(-1);
      if (goal && f.goalKind === "goal-line" && goal.zone.kind === "cylinder")
        goal.zone = { kind: "goal-line", waypoint: goal.zone.waypoint, length: GOAL_LINE_LENGTH };
      else if (goal && f.goalKind === "cylinder" && goal.zone.kind === "goal-line")
        goal.zone = { kind: "cylinder", waypoint: goal.zone.waypoint, radius: Math.max(GOAL_LINE_LENGTH, goal.zone.length / 2) };
      // Portes de départ et deadline, en heures locales : à corriger si le QR code de la manche est faux.
      if (f.startGates !== undefined) {
        const gates = String(f.startGates).split(/[\s,;]+/).filter(Boolean);
        if (!gates.length) throw new Error(t("Indiquez au moins une porte de départ."));
        task.startGates = gates.map((g) => localHmsToUtc(g, date, tz)).sort();
      }
      if (f.deadline !== undefined) {
        const dl = String(f.deadline).trim();
        if (dl) task.deadline = localHmsToUtc(dl, date, tz);
        else delete task.deadline;
      }
      // Tolérance relative des cylindres (9.1.1), saisie en % ; vide = celle de la formule (0,1 % PWCA, 0 % S7F).
      const ct = String(f.cylinderTolerance ?? "").trim().replace(",", ".");
      if (ct === "") delete task.cylinderTolerance;
      else if (Number.isFinite(Number(ct)) && Number(ct) >= 0 && Number(ct) <= 1) task.cylinderTolerance = Number(ct) / 100;
      else throw new Error(t("Tolérance des cylindres : pourcentage entre 0 et 1 attendu."));
      // Elevated goal (13.1) : hauteur au-dessus de l'altitude publiée du goal ; vide ou 0 = goal ordinaire.
      const eg = String(f.elevatedGoal ?? "").trim().replace(",", ".");
      if (eg === "" || Number(eg) === 0) delete task.elevatedGoal;
      else if (Number.isFinite(Number(eg)) && Number(eg) > 0 && Number(eg) <= 1000) task.elevatedGoal = Number(eg);
      else throw new Error(t("Elevated goal : hauteur entre 0 et 1000 m attendue."));
      // Règles anciennes : ligne de goal orientée vers le centre de la balise précédente (S7F 2024).
      if (f.goalLineOrientation === "previousCentre") task.goalLineOrientation = "previousCentre";
      else delete task.goalLineOrientation;
      if (stop) task.stopAnnouncement = localHmsToUtc(stop, date, tz);
      else delete task.stopAnnouncement;
      const gr = String(f.bonusGlideRatio ?? "").trim().replace(",", ".");
      if (gr === "") delete task.bonusGlideRatio;
      else if (Number.isFinite(Number(gr)) && Number(gr) >= 0) task.bonusGlideRatio = Number(gr);
      else throw new Error(t("Finesse du bonus d'altitude : nombre positif attendu."));
      delete task.leadingTimeRatio;
      delete task.pilotsPresent;
      delete task.taskEndTime;
      delete task.leadingEnd;
      delete task.leadingFormula;
      Object.assign(task, taskScoringFromForm(f));
      if (end) task.taskEndTime = localHmsToUtc(end, date, tz);
    } catch (e) {
      return taskPage(c, x.t, x.comp, { error: (e as Error).message });
    }
    db.prepare("UPDATE tasks SET date = ?, task = ? WHERE id = ?").run(date, JSON.stringify(task), x.t.id);
    if (JSON.stringify(task) !== x.t.task) touchScoring(db, x.t.id);
    return c.redirect(`/tasks/${x.t.id}/edit#task-settings`);
  });

  // Nouvelle définition (QR corrigé) : balises, portes et deadline remplacées ; les réglages de calcul
  // de la manche (elevated goal, tolérance, LTR, arrêt…) sont gardés.
  app.post("/tasks/:id/definition", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const f = await c.req.parseBody();
    let def;
    try {
      def = await readTaskDefinition(f);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      return taskPage(c, x.t, x.comp, { edit: true, error: e.message });
    }
    const old = JSON.parse(x.t.task) as StoredTask;
    const replaced = new Set(["type", "turnpoints", "startGates", "takeoffOpen", "takeoffClose", "deadline", "startDirection", "sourceEarthModel"]);
    const kept = Object.fromEntries(Object.entries(old).filter(([k]) => !replaced.has(k)));
    const task: StoredTask = { ...kept, ...def.task };
    db.prepare("UPDATE tasks SET source = ?, source_text = ?, task = ? WHERE id = ?").run(def.source, def.text, JSON.stringify(task), x.t.id);
    touchScoring(db, x.t.id);
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
    // Un .igc vide compte (pilote resté au sol, marqué DNF) ; un champ de fichier laissé vide, non.
    const list = ([] as unknown[]).concat(f.files ?? []).filter((v): v is File => v instanceof File && (v.size > 0 || /\.igc$/i.test(v.name)));
    let all;
    try {
      all = collectIgc(await Promise.all(list.map(async (v) => ({ name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) }))));
    } catch (e) {
      return taskPage(c, x.t, x.comp, { error: t("Archive illisible : {error}", { error: (e as Error).message }) });
    }
    if (!all.length) return taskPage(c, x.t, x.comp, { error: t("Aucun fichier IGC trouvé dans l'envoi.") });
    // Fichiers vides : pas de trace à garder, le pilote est marqué DNF (plus bas, après les vraies traces).
    const igcs = all.filter((g) => !isEmptyIgc(g.text));
    const empties = all.filter((g) => isEmptyIgc(g.text));
    // Fichiers écrits sur disque avant la base : une ligne de la base pointe toujours vers un fichier présent.
    const stored = igcs.map((g) => ({ g, sha256: tracks.put(g.bytes) }));
    const count = { added: 0, extra: 0, same: 0, dnf: 0 };
    // Pilote de chaque trace : HFCID de l'en-tête, sinon nom de fichier ou nom de l'en-tête rapprochés des inscrits.
    const registry = listPilots(db, x.comp.id);
    // Traces déjà dans la manche : une trace anonyme ne les remplace pas, elle prend une nouvelle clé.
    const existing = db.prepare("SELECT pilot_key, pilot_name, sha256 FROM tracks WHERE task_id = ?").all(x.t.id) as Array<{ pilot_key: string; pilot_name: string | null; sha256: string }>;
    const bySha = new Map(existing.map((e) => [e.sha256, e.pilot_key]));
    const used = new Map<string, string | null>(existing.map((e) => [e.pilot_key, e.pilot_name ? nameKey(e.pilot_name) : null]));
    const regName = new Map(registry.map((p) => [p.pilot_key, p.name]));
    const placeholderKeys = new Set(registry.filter(isPlaceholderPilot).map((p) => p.pilot_key));
    // Convention de nommage des fichiers apprise sur tout l'envoi, et sur les traces déjà rangées de la manche.
    const regKeys = new Set(registry.filter((p) => !isPlaceholderPilot(p)).map((p) => p.pilot_key));
    const conv = learnFilenameConvention(
      [
        ...igcs.map((g) => ({ filename: g.filename, text: g.text })),
        ...db
          .prepare("SELECT filename, pilot_key FROM tracks WHERE task_id = ?")
          .all(x.t.id)
          .map((r) => r as { filename: string; pilot_key: string })
          .filter((r) => regKeys.has(r.pilot_key))
          .map((r) => ({ filename: r.filename, knownId: r.pilot_key })),
      ],
      registry,
    );
    db.exec("BEGIN");
    for (const { g, sha256 } of stored) {
      // Fichier déjà présent dans la manche : c'est la même trace, elle garde son pilote.
      let pilotKey = bySha.get(sha256) ?? pilotKeyForTrack(g.filename, g.text, registry, used, conv);
      // Fichier déjà rangé sous un inscrit d'office sans numéro (« albert-nazander ») : s'il porte un numéro
      // (HFCID, convention du lot), la trace le prend ; registerTrackPilots donne ensuite ce numéro à l'inscrit.
      if (placeholderKeys.has(pilotKey)) {
        const better = pilotKeyForTrack(g.filename, g.text, registry, new Map(), conv);
        if (/^\d+$/.test(better)) {
          db.prepare("UPDATE OR IGNORE tracks SET pilot_key = ? WHERE task_id = ? AND pilot_key = ? AND sha256 = ?").run(better, x.t.id, pilotKey, sha256);
          pilotKey = better;
        }
      }
      count[saveTrack(db, x.t.id, me(c).id, { pilotKey, pilotName: regName.get(pilotKey) ?? igcPilot(g.text), filename: g.filename, sha256, size: g.bytes.length })]++;
      clearEmptyTrackDnf(db, x.t.id, pilotKey);
    }
    for (const g of empties) {
      const pilotKey = pilotKeyForTrack(g.filename, g.text, registry, new Map(), conv);
      const name = regName.get(pilotKey) ?? igcPilot(g.text) ?? filenamePilotName(g.filename);
      if (addEmptyTrackDnf(db, x.t.id, me(c).id, pilotKey, name)) count.dnf++;
    }
    // Pilotes des traces pas encore inscrits : ajoutés à la liste des pilotes de la compétition.
    registerTrackPilots(db, x.comp.id);
    db.exec("COMMIT");
    return c.redirect(`/tasks/${x.t.id}/edit?${new URLSearchParams([...Object.entries(count).filter(([, n]) => n).map(([k, n]) => [k, String(n)]), ["open", "tracks"]])}#tracks`);
  });

  // Remplacer la trace d'un pilote donné, quel que soit le nom du nouveau fichier. Le pilote garde son
  // nom : l'en-tête du nouveau fichier peut porter un autre nom (instrument prêté).
  app.post("/tasks/:id/tracks/:trackId/replace", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const tr = getTrack(db, x.t.id, Number(c.req.param("trackId")));
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
    const how = replaceTrack(db, x.t.id, tr.id, me(c).id, { pilotName: tr.pilot_name ?? igcPilot(g.text), filename: g.filename, sha256, size: g.bytes.length, note });
    if (how === "replaced") clearEmptyTrackDnf(db, x.t.id, tr.pilot_key);
    if (how === "same") return taskPage(c, x.t, x.comp, { edit: true, notice: t("Ce fichier est déjà la trace de {pilot} : rien n'a changé.", { pilot: tr.pilot_name ?? tr.pilot_key }) });
    return c.redirect(`/tasks/${x.t.id}/edit?replaced=1&open=tracks#tracks`);
  });

  // Rattacher une trace à un pilote inscrit (par son numéro dans la vue des pilotes de la compétition).
  app.post("/tasks/:id/tracks/:trackId/pilot", async (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const f = await c.req.parseBody();
    const p = listPilots(db, x.comp.id).find((r) => r.pilot_key === String(f.pilot_key ?? ""));
    if (!p) return taskPage(c, x.t, x.comp, { error: t("Choisissez un pilote inscrit.") });
    const r = assignTrack(db, x.t.id, Number(c.req.param("trackId")), me(c).id, p);
    if (r === "unknown") return notFound(c);
    if (r !== "same") touchScoring(db, x.t.id);
    if (r === "moved") clearEmptyTrackDnf(db, x.t.id, p.pilot_key);
    return c.redirect(`/tasks/${x.t.id}/edit?assigned=1&open=tracks#tracks`);
  });

  // Rattacher d'un coup les traces pas encore liées à un inscrit (liste des pilotes complétée après l'envoi).
  app.post("/tasks/:id/tracks/link", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    const n = linkTracks(db, tracks, x.t.id, me(c).id, listPilots(db, x.comp.id));
    if (n) {
      registerTrackPilots(db, x.comp.id);
      touchScoring(db, x.t.id);
    }
    return c.redirect(`/tasks/${x.t.id}/edit?linked=${n}&open=tracks#tracks`);
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

  // Retirer toutes les traces de la manche (après confirmation sur la page) : elles restent dans l'historique.
  app.post("/tasks/:id/tracks/delete-all", (c) => {
    const x = taskOf(c, c.req.param("id"));
    if (!x) return notFound(c);
    removeAllTracks(db, x.t.id, me(c).id);
    return c.redirect(`/tasks/${x.t.id}/edit#tracks`);
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
    const last = latestDoneRun(db, x.t.id);
    const scored = last ? (JSON.parse(last.results) as { chosenTracks?: Record<string, string> }).chosenTracks?.[key] : undefined;
    const versions = pilotVersions(db, x.t.id, key, scored);
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
    const run = latestDoneRun(db, x.t.id);
    if (!run) return notFound(c);
    const scoring = JSON.parse(run.results) as TaskScoring;
    const rk = taskRankings(x.comp, c.req.query("r"));
    if (rk.current) scoring.pilots = scoring.pilots.filter((p) => rk.current!.members.has(p.id));
    // Trace en erreur sans décision de l'organisateur : pas dans les résultats publiés.
    scoring.pilots = publishedPilots(scoring.pilots);
    const csv = resultsCsv(scoring, parseSettings(x.comp.params).timeZone, goalAltitudeOf(JSON.parse(x.t.task) as StoredTask));
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="manche-${x.t.number}.csv"`,
    });
  });
}
