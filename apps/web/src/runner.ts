import { controlPilot, finishScoring, parseOpenAir, type ControlledPilot, type Task } from "@pgscore/engine";
import type { CompetitionRow, Db, RunDetail, RunStep, TaskRow } from "./db.js";
import { parseSettings } from "./settings.js";
import type { TrackStore } from "./track-store.js";

/**
 * Calcul d'une manche, lancé à la main. Il tourne dans le processus du serveur, un pilote à la fois,
 * en rendant la main entre deux pilotes pour que les pages restent servies. L'avancement est
 * enregistré en base, la page de la manche le relit.
 */

const running = new Set<number>();
export const isRunning = (taskId: number) => running.has(taskId);

export function startRun(db: Db, tracks: TrackStore, taskId: number, userId: number): number {
  if (running.has(taskId)) throw new Error("Un calcul est déjà en cours pour cette manche.");
  const total = (db.prepare("SELECT COUNT(*) n FROM tracks WHERE task_id = ?").get(taskId) as { n: number }).n;
  if (!total) throw new Error("Aucune trace : envoyez les fichiers IGC avant de lancer le calcul.");
  const r = db
    .prepare("INSERT INTO runs (task_id, status, done, total, started_by, started_at) VALUES (?, 'queued', 0, ?, ?, ?)")
    .run(taskId, total, userId, Date.now());
  const runId = Number(r.lastInsertRowid);
  running.add(taskId);
  void execute(db, tracks, taskId, runId).finally(() => running.delete(taskId));
  return runId;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function execute(db: Db, tracks: TrackStore, taskId: number, runId: number): Promise<void> {
  const progress = db.prepare("UPDATE runs SET status = 'running', step = ?, done = ?, detail = ? WHERE id = ?");
  const report = (step: RunStep, done: number, detail: RunDetail) => progress.run(step, done, JSON.stringify(detail), runId);
  try {
    // 1. Manche, paramètres et espaces aériens.
    report("prepare", 0, {});
    await tick();
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as unknown as TaskRow;
    const comp = db.prepare("SELECT * FROM competitions WHERE id = ?").get(t.competition_id) as unknown as CompetitionRow;
    const task = JSON.parse(t.task) as Task;
    const s = parseSettings(comp.params);
    const options = {
      params: s,
      airspaces: comp.airspace_text ? parseOpenAir(comp.airspace_text) : [],
      airspacePenaltyRule: s.airspacePenaltyRule,
      roundAirspaceLimits: s.roundAirspaceLimits,
      leadingProfile: s.leadingProfile,
    };
    const ids = db.prepare("SELECT id FROM tracks WHERE task_id = ? ORDER BY pilot_key").all(taskId) as Array<{ id: number }>;
    const getTrack = db.prepare("SELECT pilot_key, pilot_name, sha256 FROM tracks WHERE id = ?");

    // 2. Contrôle des traces, une par une, avec des compteurs pour la page.
    const detail: Required<Pick<RunDetail, "counts" | "recent">> & RunDetail = {
      airspaces: options.airspaces.length,
      counts: { GOAL: 0, ESS: 0, DF: 0, MIND: 0, ERREUR: 0 },
      airspaceInfringements: 0,
      recent: [],
    };
    report("control", 0, detail);
    const controlled: ControlledPilot[] = [];
    for (const [i, { id }] of ids.entries()) {
      await tick();
      const tr = getTrack.get(id) as { pilot_key: string; pilot_name: string | null; sha256: string };
      detail.pilot = tr.pilot_name ?? tr.pilot_key;
      report("control", i, detail);
      const igc = tracks.text(tr.sha256);
      const input = tr.pilot_name ? { id: tr.pilot_key, name: tr.pilot_name, igc } : { id: tr.pilot_key, igc };
      const cp = controlPilot(task, input, options);
      controlled.push(cp);
      const r = cp.result;
      // Avant le leading, ERREUR vaut aussi pour une trace sans vol : le statut final est celui du classement.
      detail.counts[r.error ? "ERREUR" : r.status] = (detail.counts[r.error ? "ERREUR" : r.status] ?? 0) + 1;
      if (r.airspace.length) detail.airspaceInfringements = (detail.airspaceInfringements ?? 0) + 1;
      const note = r.error ?? (r.airspace.length ? `espace aérien ${r.airspace[0]!.name}` : undefined);
      detail.recent = [{ name: r.name, status: r.error ? "ERREUR" : r.status, distance: r.distance, ...(note ? { note } : {}) }, ...detail.recent].slice(0, 6);
      report("control", i + 1, detail);
    }

    // 3. Leading (dépend de tous les pilotes) et classement.
    delete detail.pilot;
    report("leading", ids.length, detail);
    await tick();
    const result = finishScoring(task, controlled, options);

    // 4. Enregistrement.
    report("save", ids.length, detail);
    await tick();
    db.prepare("UPDATE runs SET status = 'done', results = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(result), Date.now(), runId);
  } catch (e) {
    db.prepare("UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run((e as Error).message, Date.now(), runId);
  }
}
