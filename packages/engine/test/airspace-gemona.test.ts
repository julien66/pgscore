import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { airspaceInfringements, airspacePenalty, controlFlight, parseIgc, parseOpenAir, parseXctsk } from "../src/index.js";

/** Traces de Gemona 2026 manche 3 (zip PWCA décompressé), hors dépôt. */
const dir = process.env.GEMONA_T3_IGC_DIR;
const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

describe.skipIf(!dir || !existsSync(dir))("espaces aériens PWCA Gemona 2026, manche 3", () => {
  const task = parseXctsk(fixture("pwca-gemona-2026-t3.qr.txt").trim());
  const airspaces = parseOpenAir(fixture("pwca-gemona-2026-airspace.txt"));
  // Pénalités publiées par la PWCA (formule soft, f = 100).
  const published: Record<string, number> = { "260": 1.8, "261": 432, "269": 10.8, "219": 1000, "775": 1000 };
  const results = new Map<string, number>();
  if (dir && existsSync(dir)) for (const f of readdirSync(dir!).filter((f) => f.endsWith(".igc"))) {
    const id = f.replace(/^alt_\d+\./, "").replace(/\.igc$/, "");
    const c = controlFlight(task, parseIgc(readFileSync(`${dir}/${f}`, "latin1")).fixes);
    const inf = airspaceInfringements(airspaces, c.inFlight, { roundLimitsToMetre: true });
    if (inf.length) results.set(id, airspacePenalty(Math.max(...inf.map((i) => i.depth)), 100));
  }

  it("trouve les mêmes pilotes en infraction", () => {
    expect([...results.keys()].sort()).toEqual(Object.keys(published).sort());
  });
  it("retrouve les pénalités, sauf 260 (arc DB à rayons inégaux, voir comparaison)", () => {
    for (const id of ["261", "269", "219", "775"]) expect(results.get(id)).toBeCloseTo(published[id]!, 0);
    expect(results.get("260")).toBeLessThan(5);
  });
});
