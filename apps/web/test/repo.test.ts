import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, openDb, type CompetitionRow } from "../src/db.js";
import { getCompetition, latestDoneRun, latestRun, purgeRuns, tasksOf } from "../src/repo.js";
import { competitionWinners } from "../src/standings.js";
import { TrackStore } from "../src/track-store.js";

const fresh = () => openDb(":memory:", new TrackStore(mkdtempSync(join(tmpdir(), "pgscore-repo-"))));

describe("accès aux données", () => {
  it("distingue le dernier calcul lancé du dernier calcul terminé", () => {
    const db = fresh();
    db.exec(`INSERT INTO users (id, provider, subject, created_at) VALUES (1, 'dev', 'a', 0);
             INSERT INTO competitions (id, owner_id, name, params, created_at) VALUES (1, 1, 'C', '{}', 0);
             INSERT INTO tasks (id, competition_id, number, source, source_text, task, created_at) VALUES (1, 1, 2, 'x', '', '{}', 0), (2, 1, 1, 'x', '', '{}', 0);`);
    expect(latestRun(db, 1)).toBeNull();
    expect(latestDoneRun(db, 1)).toBeNull();
    const run = db.prepare("INSERT INTO runs (task_id, status, done, total, results, started_at) VALUES (1, ?, 0, 0, ?, ?)");
    run.run("done", "{}", 1);
    run.run("error", null, 2);
    expect(latestRun(db, 1)?.status).toBe("error");
    expect(latestDoneRun(db, 1)?.started_at).toBe(1);
    expect(tasksOf(db, 1).map((t) => t.number)).toEqual([1, 2]);
  });

  it("cherche les calculs et les manches par index", () => {
    const db = fresh();
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan("SELECT * FROM runs WHERE task_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1")).toContain("runs_task_status");
    expect(plan("SELECT * FROM tasks WHERE competition_id = ? ORDER BY number, id")).toContain("tasks_competition");
  });

  it("ne garde que le dernier calcul et le dernier calcul terminé de la manche", () => {
    const db = fresh();
    seed(db);
    const run = db.prepare("INSERT INTO runs (task_id, status, done, total, results, started_at) VALUES (?, ?, 0, 0, ?, 0)");
    for (const [task, status] of [[1, "done"], [1, "done"], [1, "error"], [1, "error"], [2, "done"], [2, "error"]] as const) run.run(task, status, status === "done" ? "{}" : null);
    const ids = () => (db.prepare("SELECT id FROM runs ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
    purgeRuns(db, 1);
    expect(ids()).toEqual([2, 4, 5, 6]);
    // Même règle pour toutes les manches, à la migration.
    for (const [task, status] of [[2, "done"], [2, "error"], [2, "error"]] as const) run.run(task, status, status === "done" ? "{}" : null);
    db.exec(MIGRATIONS.find((m) => typeof m === "string" && m.trimStart().startsWith("DELETE FROM runs")) as string);
    expect(ids()).toEqual([2, 4, 7, 9]);
  });

  it("garde les vainqueurs en mémoire jusqu'au calcul suivant", () => {
    const db = fresh();
    seed(db);
    db.exec("UPDATE competitions SET start_date = '2020-01-01', end_date = '2020-01-02'; UPDATE tasks SET official = 1");
    const results = (name: string) =>
      JSON.stringify({ pilots: [{ id: "1", name, status: "GOAL", total: 900 }], gap: { available: { distance: 0, time: 0, leading: 0, arrival: 0 }, validity: { task: 1 } } });
    const run = db.prepare("INSERT INTO runs (task_id, status, done, total, results, started_at) VALUES (1, 'done', 0, 0, ?, 0)");
    run.run(results("Anna"));
    const comp = getCompetition(db, 1) as CompetitionRow;
    const first = competitionWinners(db, comp);
    expect(first?.overall).toBe("Anna");
    expect(competitionWinners(db, comp)).toBe(first);
    run.run(results("Berta"));
    expect(competitionWinners(db, comp)?.overall).toBe("Berta");
  });
});

function seed(db: ReturnType<typeof fresh>) {
  db.exec(`INSERT INTO users (id, provider, subject, created_at) VALUES (1, 'dev', 'a', 0);
           INSERT INTO competitions (id, owner_id, name, params, created_at) VALUES (1, 1, 'C', '{}', 0);
           INSERT INTO tasks (id, competition_id, number, source, source_text, task, created_at) VALUES (1, 1, 1, 'x', '', '{}', 0), (2, 1, 2, 'x', '', '{}', 0);`);
}
