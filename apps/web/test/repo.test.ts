import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { latestDoneRun, latestRun, tasksOf } from "../src/repo.js";
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
});
