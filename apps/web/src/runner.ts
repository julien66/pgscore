import { controlPilot, finishScoring, parseOpenAir, type ControlledPilot, type Task } from "@pgscore/engine";
import type { CompetitionRow, Db, TaskRow } from "./db.js";
import { parseSettings } from "./settings.js";

/**
 * Calcul d'une manche, lancé à la main. Il tourne dans le processus du serveur, un pilote à la fois,
 * en rendant la main entre deux pilotes pour que les pages restent servies. L'avancement est
 * enregistré en base, la page de la manche le relit.
 */

const running = new Set<number>();
export const isRunning = (taskId: number) => running.has(taskId);

export function startRun(db: Db, taskId: number, userId: number): number {
  if (running.has(taskId)) throw new Error("Un calcul est déjà en cours pour cette manche.");
  const total = (db.prepare("SELECT COUNT(*) n FROM tracks WHERE task_id = ?").get(taskId) as { n: number }).n;
  if (!total) throw new Error("Aucune trace : envoyez les fichiers IGC avant de lancer le calcul.");
  const r = db
    .prepare("INSERT INTO runs (task_id, status, done, total, started_by, started_at) VALUES (?, 'queued', 0, ?, ?, ?)")
    .run(taskId, total, userId, Date.now());
  const runId = Number(r.lastInsertRowid);
  running.add(taskId);
  void execute(db, taskId, runId).finally(() => running.delete(taskId));
  return runId;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function execute(db: Db, taskId: number, runId: number): Promise<void> {
  const setStatus = db.prepare("UPDATE runs SET status = ?, done = ? WHERE id = ?");
  try {
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
    const getTrack = db.prepare("SELECT pilot_key, pilot_name, igc FROM tracks WHERE id = ?");
    setStatus.run("running", 0, runId);
    const controlled: ControlledPilot[] = [];
    for (const [i, { id }] of ids.entries()) {
      await tick();
      const tr = getTrack.get(id) as { pilot_key: string; pilot_name: string | null; igc: string };
      const input = tr.pilot_name ? { id: tr.pilot_key, name: tr.pilot_name, igc: tr.igc } : { id: tr.pilot_key, igc: tr.igc };
      controlled.push(controlPilot(task, input, options));
      setStatus.run("running", i + 1, runId);
    }
    await tick();
    const result = finishScoring(task, controlled, options);
    db.prepare("UPDATE runs SET status = 'done', results = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(result), Date.now(), runId);
  } catch (e) {
    db.prepare("UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run((e as Error).message, Date.now(), runId);
  }
}
