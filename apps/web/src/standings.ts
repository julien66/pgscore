import { createHash } from "node:crypto";
import { competitionRanking, taskDistances, type CompetitionRanking, type Task, type TaskScoring } from "@pgscore/engine";
import type { CompetitionRow, Db, TaskRow } from "./db.js";
import { controlTask, parseSettings } from "./settings.js";
import { listPilots } from "./pilots.js";
import { listRankings, rankingMembers } from "./rankings.js";
import { latestDoneRun, tasksOf } from "./repo.js";

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
  /** Dernier calcul : pilotes au goal et points du vainqueur (validité FTV = vainqueur / 1000). */
  goal?: number;
  winner?: number;
}

export interface Standings {
  /** Toutes les manches, dans l'ordre. */
  tasks: StandingsTask[];
  /** Manches officielles et calculées, dans l'ordre (clé = id de la manche). */
  ranked: StandingsTask[];
  ranking: CompetitionRanking;
  /** Toutes les manches officielles calculées, même quand la vue s'arrête à l'une d'elles (onglets des manches). */
  official: StandingsTask[];
  /** Vue à la manche : la manche choisie, seule ou en cumul jusqu'à elle. */
  view?: { task: StandingsTask; cumulative: boolean; detail?: TaskDetail };
}

/** Manche seule : son dernier calcul complet, pour le tableau détaillé de la page de la manche. */
export interface TaskDetail {
  results: TaskScoring;
  timeZone: string;
  speedSection: number;
}

/** Vue demandée : une manche (id), seule ou en cumul des manches officielles jusqu'à elle. */
export interface StandingsView {
  task?: number;
  cumulative?: boolean;
}

/**
 * Classement général : dernier calcul de chaque manche officielle, avec le FTV de la compétition.
 * Avec une manche, le classement de cette manche seule (sans FTV), ou le général arrêté après elle.
 * Tout vient des calculs déjà enregistrés : rien n'est recalculé ni stocké en plus.
 */
export function competitionStandings(db: Db, comp: CompetitionRow, view: StandingsView = {}): Standings {
  const rows = tasksOf(db, comp.id);
  const tasks: StandingsTask[] = [];
  const inputs = [];
  const ranked: StandingsTask[] = [];
  // Nom des inscrits plutôt que celui des traces.
  const names = new Map(listPilots(db, comp.id).map((p) => [p.pilot_key, p.name]));
  let viewed: TaskScoring | undefined;
  for (const t of rows) {
    const run = latestDoneRun(db, t.id);
    const st: StandingsTask = {
      t,
      official: t.official === 1,
      calculatedAt: run?.started_at ?? null,
      stale: run ? lastScoringChange(db, t).changed > run.started_at : false,
    };
    tasks.push(st);
    if (!run) continue;
    const r = JSON.parse(run.results) as TaskScoring;
    st.goal = r.pilots.filter((p) => p.status === "GOAL").length;
    st.winner = Math.max(0, ...r.pilots.map((p) => p.total ?? 0));
    if (!st.official) continue;
    if (t.id === view.task) viewed = r;
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
  const settings = parseSettings(comp.params);
  const ftv = settings.ftvFactor;
  const at = view.task === undefined ? -1 : ranked.findIndex((x) => x.t.id === view.task);
  if (at < 0) return { tasks, ranked, official: ranked, ranking: competitionRanking(inputs, ftv) };
  const task = ranked[at]!;
  if (view.cumulative) {
    const last = tasks.indexOf(task);
    return {
      tasks: tasks.slice(0, last + 1),
      ranked: ranked.slice(0, at + 1),
      official: ranked,
      ranking: competitionRanking(inputs.slice(0, at + 1), ftv),
      view: { task, cumulative: true },
    };
  }
  // Manche seule : ses points, sans FTV (facteur 0, donc tout compte), et le détail de son calcul.
  const detail: TaskDetail = {
    results: viewed!,
    timeZone: settings.timeZone,
    speedSection: taskDistances(controlTask(JSON.parse(task.t.task) as Task, settings)).speedSection,
  };
  return { tasks: [task], ranked: [task], official: ranked, ranking: competitionRanking([inputs[at]!], 0), view: { task, cumulative: false, detail } };
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

export interface CompetitionSummary {
  /** Nombre de manches. */
  tasks: number;
  /** Pilotes inscrits, à défaut pilotes ayant une trace ou un résultat. */
  pilots: number;
  /** Somme des distances parcourues (9.3) au dernier calcul de chaque manche, en mètres. */
  flown: number;
}

/** Chiffres de la liste des compétitions : manches, participants, distance volée. */
export function competitionSummaries(db: Db): Map<number, CompetitionSummary> {
  const rows = db
    .prepare(
      `WITH last AS (
         SELECT t.competition_id, j.value
           FROM tasks t
           JOIN runs r ON r.id = (SELECT MAX(id) FROM runs WHERE task_id = t.id AND status = 'done')
           JOIN json_each(r.results, '$.pilots') j
       )
       SELECT c.id,
              (SELECT COUNT(*) FROM tasks t WHERE t.competition_id = c.id) AS tasks,
              (SELECT COUNT(*) FROM competition_pilots p WHERE p.competition_id = c.id) AS registered,
              (SELECT COUNT(*) FROM (
                 SELECT tr.pilot_key FROM tracks tr JOIN tasks t ON t.id = tr.task_id WHERE t.competition_id = c.id
                 UNION
                 SELECT CAST(json_extract(j.value, '$.id') AS TEXT) FROM last j WHERE j.competition_id = c.id)) AS tracked,
              (SELECT COALESCE(SUM(json_extract(j.value, '$.flownDistance')), 0) FROM last j WHERE j.competition_id = c.id) AS flown
         FROM competitions c`,
    )
    .all() as Array<{ id: number; tasks: number; registered: number; tracked: number; flown: number }>;
  return new Map(rows.map((r) => [r.id, { tasks: r.tasks, pilots: r.registered || r.tracked, flown: r.flown }]));
}

export interface CompetitionWinners {
  overall: string | null;
  women: string | null;
}

/** Classement féminin : celui dont la règle est « genre F » (ajouts et retraits à la main compris), sinon les pilotes F. */
function womenKeys(db: Db, comp: CompetitionRow): Set<string> {
  const pilots = listPilots(db, comp.id);
  const r = listRankings(db, comp.id).find((x) => {
    const c = x.rule.conditions;
    return c.length === 1 && c[0]!.field === "gender" && c[0]!.op === "in" && c[0]!.value.trim().toUpperCase() === "F";
  });
  return r ? rankingMembers(r, pilots) : new Set(pilots.filter((p) => p.gender?.toUpperCase() === "F").map((p) => p.pilot_key));
}

/**
 * Tout ce dont dépendent les vainqueurs : réglages, manches, dernier calcul terminé de chacune, pilotes
 * et classements. Bien moins cher à lire que le classement lui-même, qui relit tous les résultats.
 */
function winnersKey(db: Db, comp: CompetitionRow): string {
  const tasks = tasksOf(db, comp.id).map((t) => [t.id, t.number, t.official, t.task, latestDoneRun(db, t.id)?.id ?? null]);
  const rankings = listRankings(db, comp.id).map((r) => [r.row, [...r.overrides]]);
  const data = JSON.stringify([comp.params, comp.start_date, comp.end_date, tasks, listPilots(db, comp.id), rankings]);
  return createHash("sha256").update(data).digest("hex");
}

/** Vainqueurs déjà calculés, par base et par compétition, avec la clé des données dont ils viennent. */
const winnersCache = new WeakMap<Db, Map<number, { key: string; winners: CompetitionWinners }>>();

/**
 * Vainqueurs du général et du classement féminin (ex aequo réunis), une fois la compétition terminée.
 * Gardés en mémoire tant que rien de ce dont ils dépendent ne change (l'accueil les montre à chaque visite).
 */
export function competitionWinners(db: Db, comp: CompetitionRow, today = new Date().toISOString().slice(0, 10)): CompetitionWinners | null {
  const end = comp.end_date || comp.start_date;
  if (!end || end >= today) return null;
  let cache = winnersCache.get(db);
  if (!cache) winnersCache.set(db, (cache = new Map()));
  const key = winnersKey(db, comp);
  const hit = cache.get(comp.id);
  if (hit?.key === key) return hit.winners;
  const winners = computeWinners(db, comp);
  cache.set(comp.id, { key, winners });
  return winners;
}

function computeWinners(db: Db, comp: CompetitionRow): CompetitionWinners {
  const all = competitionStandings(db, comp);
  const first = (s: Standings) => {
    const p = s.ranking.pilots.filter((x) => x.rank === 1 && x.total > 0);
    return p.length ? p.map((x) => x.name).join(", ") : null;
  };
  const women = womenKeys(db, comp);
  return { overall: first(all), women: women.size ? first(extractStandings(all, women)) : null };
}
