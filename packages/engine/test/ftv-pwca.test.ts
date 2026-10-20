import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { competitionRanking } from "../src/ftv.js";

// Classements généraux officiels PWCA (SVL, FTV 25 %).
// Une case « 491.8/~~981.5~~ » : part retenue / score de la manche ; « ~~714.6~~ » : manche non retenue.
const raw = (c: string) => Number(c.includes("~~") ? /~~([\d.]+)~~/.exec(c)![1] : c);
const counted = (c: string) => (c.includes("/") ? Number(c.split("/")[0]) : c.includes("~~") ? 0 : Number(c));

const cases = [
  // 6 manches.
  { name: "Baixo Guandu 2026", file: "pwca-baixo-2026-overall.csv", tasks: [1, 2, 3, 4, 5, 6], stopped: [] as number[], fixed: 4.4757 },
  // Manche 1 annulée (invalide), manche 6 arrêtée.
  { name: "Gemona 2026", file: "pwca-gemona-2026-overall.csv", tasks: [2, 3, 4, 5, 6, 7], stopped: [6], fixed: null },
];

for (const k of cases) {
  describe(`FTV comparé au classement général PWCA de ${k.name}`, () => {
    const lines = readFileSync(new URL(`fixtures/${k.file}`, import.meta.url), "utf8").trim().split("\n");
    const head = lines[0]!.slice(1, -1).split('","');
    const rows = lines.slice(1).map((l) => l.slice(1, -1).split('","'));
    const col = (t: number) => head.indexOf(`T${t}`);
    const total = head.indexOf("Total");
    const res = competitionRanking(
      k.tasks.map((t) => ({ key: `T${t}`, stopped: k.stopped.includes(t), results: rows.map((r) => ({ pilot: r[1]!, name: r[2]!, total: raw(r[col(t)]!) })) })),
      0.25,
    );

    if (k.fixed !== null) it("retrouve la validité totale fixe", () => expect(res.fixedTotalValidity).toBeCloseTo(k.fixed!, 9));

    it(`retrouve le total, le rang et la part retenue de chaque manche pour les ${rows.length} pilotes`, () => {
      for (const r of rows) {
        const p = res.pilots.find((x) => x.pilot === r[1])!;
        expect(p.total, r[2]).toBeCloseTo(Number(r[total]), 5);
        expect(p.rank, r[2]).toBe(Number(r[0]));
        for (const t of k.tasks) expect(p.tasks[`T${t}`]!.counted, `${r[2]} T${t}`).toBeCloseTo(counted(r[col(t)]!), 1);
      }
    });
  });
}
