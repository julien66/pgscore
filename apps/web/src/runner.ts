import { Worker } from "node:worker_threads";
import type { CompetitionRow, Db, RunDetail, RunStep, TaskRow } from "./db.js";
import { engineDecisions, listDecisions } from "./decisions.js";
import { listPilots } from "./pilots.js";
import { controlTask, parseSettings, type StoredTask } from "./settings.js";
import type { TrackStore } from "./track-store.js";
import { t } from "./i18n.js";
import { getCompetition, getTask, purgeRuns, queryAll } from "./repo.js";
import type { ScoreJob, ScoreMessage } from "./score-worker.js";

/**
 * Calcul d'une manche, lancé à la main. Le contrôle des traces et le classement tournent dans un
 * worker_thread (score-worker.ts), pour que les pages restent servies pendant le calcul. L'avancement
 * est enregistré en base par le fil principal, la page de la manche le relit.
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

/**
 * Lance le calcul dans un worker (score-worker.ts). Le worker enregistre d'abord tsx, qui compile le
 * TypeScript à la volée comme pour le serveur (l'option --import de tsx ne vaut pas pour l'entrée d'un worker).
 */
const BOOT = `import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then((tsx) => {
  tsx.register();
  return import(${JSON.stringify(new URL("./score-worker.ts", import.meta.url).href)});
});`;
const spawnScoring = (job: ScoreJob) => new Worker(BOOT, { eval: true, workerData: job });

async function execute(db: Db, tracks: TrackStore, taskId: number, runId: number): Promise<void> {
  const progress = db.prepare("UPDATE runs SET status = 'running', step = ?, done = ?, detail = ? WHERE id = ?");
  const report = (step: RunStep, done: number, detail: RunDetail) => progress.run(step, done, JSON.stringify(detail), runId);
  try {
    // 1. Manche, paramètres et pilotes, lus ici : le worker ne touche pas à la base.
    report("prepare", 0, {});
    const row = getTask(db, taskId)!;
    const comp = getCompetition(db, row.competition_id)!;
    const s = parseSettings(comp.params);
    const task = controlTask(JSON.parse(row.task) as StoredTask, s);
    // Nom du pilote inscrit sous ce numéro (vue des pilotes de la compétition) plutôt que celui de la trace.
    const regName = new Map(listPilots(db, comp.id).map((p) => [p.pilot_key, p.name]));
    const list = queryAll<{ pilot_key: string; pilot_name: string | null; sha256: string }>(
      db,
      "SELECT pilot_key, pilot_name, sha256 FROM tracks WHERE task_id = ? ORDER BY pilot_key, id",
      taskId,
    ).map((tr) => ({ ...tr, pilot_name: regName.get(tr.pilot_key) ?? tr.pilot_name }));
    const job: ScoreJob = {
      storeDir: tracks.dir,
      task,
      airspaceText: comp.airspace_text,
      tracks: list,
      options: {
        params: s,
        airspacePenaltyRule: s.airspacePenaltyRule,
        roundAirspaceLimits: s.roundAirspaceLimits,
        gapProfile: s.gapProfile,
        ...(task.leadingTimeRatio !== undefined ? { leadingTimeRatio: task.leadingTimeRatio } : {}),
        ...(task.pilotsPresent !== undefined ? { pilotsPresent: task.pilotsPresent } : {}),
        ...(task.taskEndTime ? { taskEndTime: task.taskEndTime } : {}),
        ...(task.leadingEnd ? { leadingEnd: task.leadingEnd } : {}),
        ...(task.leadingFormula ? { leadingFormula: task.leadingFormula } : {}),
        decisions: engineDecisions(listDecisions(db, taskId)),
      },
    };

    // 2 et 3. Contrôle des traces puis leading, dans le worker ; ses messages tiennent la page à jour.
    const detail: Required<Pick<RunDetail, "counts" | "recent">> & RunDetail = {
      counts: { GOAL: 0, ESS: 0, DF: 0, MIND: 0, ERREUR: 0 },
      airspaceInfringements: 0,
      recent: [],
    };
    const result = await new Promise<unknown>((resolve, reject) => {
      const worker = spawnScoring(job);
      let finished = false;
      worker.on("message", (m: ScoreMessage) => {
        if (m.type === "airspaces") {
          detail.airspaces = m.count;
          report("control", 0, detail);
        } else if (m.type === "start") {
          detail.pilot = m.pilot;
          report("control", m.index, detail);
        } else if (m.type === "pilot") {
          // Avant le leading, ERREUR vaut aussi pour une trace sans vol : le statut final est celui du classement.
          const status = m.error ? "ERREUR" : m.status;
          detail.counts[status] = (detail.counts[status] ?? 0) + 1;
          if (m.airspace) detail.airspaceInfringements = (detail.airspaceInfringements ?? 0) + 1;
          const note = m.error ?? (m.airspace ? t("espace aérien {name}", { name: m.airspace }) : undefined);
          detail.recent = [{ name: m.name, status, distance: m.distance, ...(note ? { note } : {}) }, ...detail.recent].slice(0, 6);
          report("control", m.index + 1, detail);
        } else if (m.type === "leading") {
          delete detail.pilot;
          report("leading", list.length, detail);
        } else {
          finished = true;
          resolve(m.result);
        }
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (!finished) reject(new Error(t("Le calcul s'est arrêté (code {code}).", { code: String(code) })));
      });
    });

    // 4. Enregistrement.
    report("save", list.length, detail);
    db.prepare("UPDATE runs SET status = 'done', results = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(result), Date.now(), runId);
  } catch (e) {
    db.prepare("UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run((e as Error).message, Date.now(), runId);
  }
  purgeRuns(db, taskId);
}
