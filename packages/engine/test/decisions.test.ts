import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { competitionParameters, finishScoring, parseXctsk, taskDistances, type ControlledPilot, type PilotResult } from "../src/index.js";

const task = parseXctsk(readFileSync(new URL("./fixtures/pwca-baixo-guandu-2026-t1.qr.txt", import.meta.url), "utf8").trim());
const params = competitionParameters({ minimumDistance: 3000, nominalDistance: 50_000, nominalTime: 4800 });

/** Pilote contrôlé fictif : seul le résultat compte pour les points. */
function pilot(id: string, r: Partial<PilotResult>): ControlledPilot {
  const result: PilotResult = {
    id, name: id, status: "DF", startTime: null, essTime: null, goalTime: null, speedSectionTime: null, flownDistance: 40_000, distance: 40_000,
    stop: null, leadingCoefficient: null, leadingFactor: null, airspace: [], airspacePenalty: null, approaches: [], points: null, score: null,
    penaltyPoints: null, total: null, fixes: 100, warnings: 0, ...r,
  };
  return { result, control: null, leading: null };
}

const field = () => [
  pilot("a", { status: "GOAL", distance: 74_000, flownDistance: 74_000, speedSectionTime: 9000 }),
  pilot("b", { status: "ESS", distance: 73_900, flownDistance: 73_900, speedSectionTime: 9100 }),
  pilot("c", {}),
  pilot("d", {}),
];
const byId = (r: ReturnType<typeof finishScoring>, id: string) => r.pilots.find((p) => p.id === id)!;

describe("décisions de l'organisateur", () => {
  it("bonus et pénalité en points, pénalité en pourcentage (13.5)", () => {
    const plain = finishScoring(task, field(), { params });
    const r = finishScoring(task, field(), {
      params,
      decisions: [
        { pilot: "c", kind: "bonus", value: 50, reason: "Aide à un pilote accidenté" },
        { pilot: "d", kind: "penalty-percent", value: 10, reason: "Comportement" },
        { pilot: "d", kind: "penalty", value: 20, reason: "Retard au briefing" },
      ],
    });
    expect(byId(r, "c").total).toBeCloseTo(byId(plain, "c").total! + 50, 1);
    expect(byId(r, "d").total).toBeCloseTo(byId(plain, "d").total! * 0.9 - 20, 1);
    expect(byId(r, "c").decisions).toEqual([{ kind: "bonus", value: 50, reason: "Aide à un pilote accidenté" }]);
  });

  it("goal accordé : distance de la manche et temps mesuré à l'ESS", () => {
    const r = finishScoring(task, field(), { params, decisions: [{ pilot: "b", kind: "goal", reason: "Réclamation" }] });
    const b = byId(r, "b");
    expect(b.status).toBe("GOAL");
    expect(b.distance).toBe(taskDistances(task).task);
    expect(b.points!.time).toBeGreaterThan(0);
    expect(r.gap.pilotsGoal).toBe(2);
  });

  it("ABS et DNF : hors des volants, DNF compte parmi les présents (10.1)", () => {
    const r = finishScoring(task, field(), {
      params,
      decisions: [
        { pilot: "x", name: "Absent", kind: "abs", reason: "Malade" },
        { pilot: "y", name: "Resté au sol", kind: "dnf", reason: "Conditions" },
        { pilot: "d", kind: "dnf", reason: "N'a pas décollé" },
      ],
    });
    expect(r.gap.pilotsFlying).toBe(3);
    expect(r.gap.pilotsPresent).toBe(5);
    expect(byId(r, "y").total).toBe(0);
    expect(byId(r, "x").status).toBe("ABS");
    expect(r.pilots.at(-1)!.id).toBe("x");
  });

  it("décollé sans trace : distance minimale (9.3)", () => {
    const r = finishScoring(task, field(), { params, decisions: [{ pilot: "z", name: "Sans trace", kind: "launched", reason: "Vu au décollage" }] });
    const z = byId(r, "z");
    expect(z.status).toBe("MIND");
    expect(z.distance).toBe(3000);
    expect(z.points!.distance).toBeGreaterThan(0);
    expect(r.gap.pilotsFlying).toBe(5);
  });
});
