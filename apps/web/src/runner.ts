import { controlPilot, finishScoringBest, parseOpenAir, type ControlledPilot, type Task } from "@pgscore/engine";
import type { CompetitionRow, Db, RunDetail, RunStep, TaskRow } from "./db.js";
import { engineDecisions, listDecisions } from "./decisions.js";
import { listPilots } from "./pilots.js";
import { controlTask, parseSettings, type StoredTask } from "./settings.js";
import type { TrackStore } from "./track-store.js";
import { t } from "./i18n.js";
import { getCompetition, getTask } from "./repo.js";

/**
 * Calcul d'une manche, lancé à la main. Il tourne dans le processus du serveur, un pilote à la fois,
 * en rendant la main entre deux pilotes pour que les pages restent servies. L'avancement est
 * enregistré en base, la page de la manche le relit.
 */

const running = new Set<number>();
export const isRunning = (taskId: number) => running.has(taskId);

export function startRun(db: Db, tracks: TrackStore, taskId: number, userId: number): number {
  if (running.has(taskId)) throw new Error(t("Un calcul est déjà en cours pour cette manche."));
  const total = (db.prepare("SELECT COUNT(*) n FROM tracks WHERE task_id = ?").get(taskId) as { n: number }).n;
  if (!total) throw new Error(t("Aucune trace : envoyez les fichiers IGC avant de lancer le calcul."));
  const r = db
    .prepare("INSERT INTO runs (task_id, status, done, total, started_by, started_at) VALUES (?, 'queued', 0, ?, ?, ?)")
    .run(taskId, total, userId, Date.now());
  const runId = Number(r.lastInsertRowid);
  running.add(taskId);
  void execute(db, tracks, taskId, runId).finally(() => running.delete(taskId));
  return runId;
}

/**
 * Calcule plusieurs manches l'une après l'autre (après un import) : chacune est mise en attente tout de
 * suite, pour que la page l'affiche, puis calculée à son tour. Les manches sans trace ou déjà en
 * calcul sont laissées de côté. Rend les manches lancées.
 */
export function startRuns(db: Db, tracks: TrackStore, taskIds: number[], userId: number): number[] {
  const queued: Array<{ taskId: number; runId: number }> = [];
  for (const taskId of taskIds) {
    if (running.has(taskId)) continue;
    const total = (db.prepare("SELECT COUNT(*) n FROM tracks WHERE task_id = ?").get(taskId) as { n: number }).n;
    if (!total) continue;
    const r = db.prepare("INSERT INTO runs (task_id, status, done, total, started_by, started_at) VALUES (?, 'queued', 0, ?, ?, ?)").run(taskId, total, userId, Date.now());
    running.add(taskId);
    queued.push({ taskId, runId: Number(r.lastInsertRowid) });
  }
  void (async () => {
    for (const { taskId, runId } of queued) {
      try {
        // Durée du calcul comptée depuis son vrai départ, pas depuis la mise en attente.
        db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(Date.now(), runId);
        await execute(db, tracks, taskId, runId);
      } finally {
        running.delete(taskId);
      }
    }
  })();
  return queued.map((q) => q.taskId);
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function execute(db: Db, tracks: TrackStore, taskId: number, runId: number): Promise<void> {
  const progress = db.prepare("UPDATE runs SET status = 'running', step = ?, done = ?, detail = ? WHERE id = ?");
  const report = (step: RunStep, done: number, detail: RunDetail) => progress.run(step, done, JSON.stringify(detail), runId);
  try {
    // 1. Manche, paramètres et espaces aériens.
    report("prepare", 0, {});
    await tick();
    const row = getTask(db, taskId)!;
    const comp = getCompetition(db, row.competition_id)!;
    const s = parseSettings(comp.params);
    const task = controlTask(JSON.parse(row.task) as StoredTask, s);
    const options = {
      params: s,
      airspaces: comp.airspace_text ? parseOpenAir(comp.airspace_text) : [],
      airspacePenaltyRule: s.airspacePenaltyRule,
      roundAirspaceLimits: s.roundAirspaceLimits,
      gapProfile: s.gapProfile,
      ...(task.leadingTimeRatio !== undefined ? { leadingTimeRatio: task.leadingTimeRatio } : {}),
      ...(task.pilotsPresent !== undefined ? { pilotsPresent: task.pilotsPresent } : {}),
      ...(task.taskEndTime ? { taskEndTime: task.taskEndTime } : {}),
      ...(task.leadingEnd ? { leadingEnd: task.leadingEnd } : {}),
      decisions: engineDecisions(listDecisions(db, taskId)),
    };
    const ids = db.prepare("SELECT id FROM tracks WHERE task_id = ? ORDER BY pilot_key, id").all(taskId) as Array<{ id: number }>;
    const getTrack = db.prepare("SELECT pilot_key, pilot_name, sha256 FROM tracks WHERE id = ?");
    // Nom du pilote inscrit sous ce numéro (vue des pilotes de la compétition) plutôt que celui de la trace.
    const regName = new Map(listPilots(db, comp.id).map((p) => [p.pilot_key, p.name]));

    // 2. Contrôle des traces, une par une, avec des compteurs pour la page.
    const detail: Required<Pick<RunDetail, "counts" | "recent">> & RunDetail = {
      airspaces: options.airspaces.length,
      counts: { GOAL: 0, ESS: 0, DF: 0, MIND: 0, ERREUR: 0 },
      airspaceInfringements: 0,
      recent: [],
    };
    report("control", 0, detail);
    // Traces contrôlées regroupées par pilote : un pilote peut en avoir plusieurs.
    const groups = new Map<string, Array<{ cp: ControlledPilot; sha256: string }>>();
    for (const [i, { id }] of ids.entries()) {
      await tick();
      const row = getTrack.get(id) as { pilot_key: string; pilot_name: string | null; sha256: string };
      const tr = { ...row, pilot_name: regName.get(row.pilot_key) ?? row.pilot_name };
      detail.pilot = tr.pilot_name ?? tr.pilot_key;
      report("control", i, detail);
      const igc = tracks.text(tr.sha256);
      const input = tr.pilot_name ? { id: tr.pilot_key, name: tr.pilot_name, igc } : { id: tr.pilot_key, igc };
      const cp = controlPilot(task, input, options);
      const g = groups.get(tr.pilot_key) ?? [];
      g.push({ cp, sha256: tr.sha256 });
      groups.set(tr.pilot_key, g);
      const r = cp.result;
      // Avant le leading, ERREUR vaut aussi pour une trace sans vol : le statut final est celui du classement.
      detail.counts[r.error ? "ERREUR" : r.status] = (detail.counts[r.error ? "ERREUR" : r.status] ?? 0) + 1;
      if (r.airspace.length) detail.airspaceInfringements = (detail.airspaceInfringements ?? 0) + 1;
      const note = r.error ?? (r.airspace.length ? t("espace aérien {name}", { name: r.airspace[0]!.name }) : undefined);
      detail.recent = [{ name: r.name, status: r.error ? "ERREUR" : r.status, distance: r.distance, ...(note ? { note } : {}) }, ...detail.recent].slice(0, 6);
      report("control", i + 1, detail);
    }

    // 3. Leading (dépend de tous les pilotes) et classement.
    delete detail.pilot;
    report("leading", ids.length, detail);
    await tick();
    const list = [...groups.values()];
    const { scoring, chosen } = finishScoringBest(task, list.map((g) => g.map((x) => x.cp)), options);
    // Trace retenue, pour les pilotes qui en ont plusieurs (affichage, visionneuse, export FS).
    const chosenTracks: Record<string, string> = {};
    list.forEach((g, i) => {
      if (g.length > 1) chosenTracks[g[0]!.cp.result.id] = g[chosen[i]!]!.sha256;
    });
    const result = Object.keys(chosenTracks).length ? { ...scoring, chosenTracks } : scoring;

    // 4. Enregistrement.
    report("save", ids.length, detail);
    await tick();
    db.prepare("UPDATE runs SET status = 'done', results = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(result), Date.now(), runId);
  } catch (e) {
    db.prepare("UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run((e as Error).message, Date.now(), runId);
  }
}
