import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { competitionRanking } from "../src/ftv.js";

// Classement général officiel PWCA Baixo Guandu 2026 (SVL 1.165, FTV 25 %, 6 manches).
// Une case « 491.8/ ~~981.5~~ » : part retenue / score de la manche ; « ~~714.6~~ » : manche non retenue.
const lines = readFileSync(new URL("fixtures/pwca-baixo-2026-overall.csv", import.meta.url), "utf8").trim().split("\n").slice(1);
const rows = lines.map((l) => l.slice(1, -1).split('","'));
const raw = (c: string) => Number(c.includes("~~") ? /~~([\d.]+)~~/.exec(c)![1] : c);
const counted = (c: string) => (c.includes("/") ? Number(c.split("/")[0]) : c.includes("~~") ? 0 : Number(c));

describe("FTV comparé au classement général PWCA de Baixo Guandu 2026", () => {
  const tasks = [0, 1, 2, 3, 4, 5].map((i) => ({
    key: `T${i + 1}`,
    results: rows.map((r) => ({ pilot: r[1]!, name: r[2]!, total: raw(r[3 + i]!) })),
  }));
  const res = competitionRanking(tasks, 0.25);

  it("retrouve la validité totale fixe", () => {
    // Vainqueurs 995,3 + 994,5 + 997,6 + 995,7 + 997,4 + 987,1, × 0,75.
    expect(res.fixedTotalValidity).toBeCloseTo(4.4757, 9);
  });

  it("retrouve le total, le rang et la part retenue de chaque manche pour les 49 pilotes", () => {
    for (const r of rows) {
      const p = res.pilots.find((x) => x.pilot === r[1])!;
      expect(p.total, r[2]).toBeCloseTo(Number(r[9]), 5);
      expect(p.rank, r[2]).toBe(Number(r[0]));
      for (let i = 0; i < 6; i++) expect(p.tasks[`T${i + 1}`]!.counted, `${r[2]} T${i + 1}`).toBeCloseTo(counted(r[3 + i]!), 1);
    }
  });
});
