import { competitionRanking, type CompetitionRanking, type Task, type TaskScoring } from "@pgscore/engine";
import type { CompetitionRow, Db, TaskRow } from "./db.js";
import { parseSettings } from "./settings.js";
import { listPilots } from "./pilots.js";

/** Dernier changement qui rend un calcul périmé : traces envoyées ou retirées, réglages, décisions. */
export function lastScoringChange(db: Db, t: TaskRow): { tracks: number; changed: number } {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM tracks WHERE task_id = ?) AS n,
              MAX(COALESCE((SELECT MAX(uploaded_at) FROM tracks WHERE task_id = ?), 0),
                  COALESCE((SELECT MAX(ended_at) FROM track_history WHERE task_id = ?), 0)) AS changed`,
    )
    .get(t.id, t.id, t.id) as { n: number; changed: number };
  return { tracks: counts.n, changed: Math.max(counts.changed, t.scoring_changed_at ?? 0) };
}

export interface StandingsTask {
  t: TaskRow;
  official: boolean;
  /** Le dernier calcul terminé, s'il y en a un. */
  calculatedAt: number | null;
  /** Des traces, réglages ou décisions ont changé depuis ce calcul. */
  stale: boolean;
  /** Validité GAP et points disponibles de la manche. */
  validity?: number;
  available?: number;
}

export interface Standings {
  /** Toutes les manches, dans l'ordre. */
  tasks: StandingsTask[];
  /** Manches officielles et calculées, dans l'ordre (clé = id de la manche). */
  ranked: StandingsTask[];
  ranking: CompetitionRanking;
}

/** Classement général : dernier calcul de chaque manche officielle, avec le FTV de la compétition. */
export function competitionStandings(db: Db, comp: CompetitionRow): Standings {
  const rows = db.prepare("SELECT * FROM tasks WHERE competition_id = ? ORDER BY number, id").all(comp.id) as unknown as TaskRow[];
  const tasks: StandingsTask[] = [];
  const inputs = [];
  const ranked: StandingsTask[] = [];
  // Nom des inscrits plutôt que celui des traces.
  const names = new Map(listPilots(db, comp.id).map((p) => [p.pilot_key, p.name]));
  for (const t of rows) {
    const run = db
      .prepare("SELECT results, started_at FROM runs WHERE task_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1")
      .get(t.id) as { results: string; started_at: number } | undefined;
    const st: StandingsTask = {
      t,
      official: t.official === 1,
      calculatedAt: run?.started_at ?? null,
      stale: run ? lastScoringChange(db, t).changed > run.started_at : false,
    };
    tasks.push(st);
    if (!st.official || !run) continue;
    const r = JSON.parse(run.results) as TaskScoring;
    const task = JSON.parse(t.task) as Task;
    const a = r.gap.available;
    st.validity = r.gap.validity.task;
    st.available = a.distance + a.time + a.leading + a.arrival;
    ranked.push(st);
    inputs.push({
      key: String(t.id),
      stopped: Boolean(task.stopAnnouncement),
      results: r.pilots.map((p) => ({ pilot: p.id, name: names.get(p.id) ?? p.name, total: p.total })),
    });
  }
  return { tasks, ranked, ranking: competitionRanking(inputs, parseSettings(comp.params).ftvFactor) };
}

export function standingsCsv(s: Standings): string {
  const q = (v: unknown) => {
    const x = v === null || v === undefined ? "" : String(v);
    return /[",\n;]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const head = ["rang", "pilote", "nom", ...s.ranked.flatMap((x) => [`m${x.t.number}`, `m${x.t.number}_retenu`]), "total", "somme_sans_ftv"];
  const rows = s.ranking.pilots.map((p) => [
    p.rank,
    p.pilot,
    p.name,
    ...s.ranked.flatMap((x) => {
      const ts = p.tasks[String(x.t.id)];
      return [ts ? ts.score.toFixed(1) : "", ts ? ts.counted.toFixed(1) : ""];
    }),
    p.total.toFixed(1),
    p.sum.toFixed(1),
  ]);
  return [head, ...rows].map((r) => r.map(q).join(",")).join("\n") + "\n";
}

/** Classement extrait : les pilotes choisis, avec leur total du général, renumérotés. */
export function extractStandings(s: Standings, keys: Set<string>): Standings {
  const pilots = s.ranking.pilots.filter((p) => keys.has(p.pilot)).map((p) => ({ ...p }));
  pilots.forEach((p, i) => {
    const prev = pilots[i - 1];
    p.rank = prev && prev.total === p.total ? prev.rank : i + 1;
  });
  return { ...s, ranking: { ...s.ranking, pilots } };
}
