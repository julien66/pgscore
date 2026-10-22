import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { controlFlight, detectFlights, parseIgc, parseXctskQr, taskDistances, type IgcFix } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// Vol vers le nord à 10 m/s jusqu'à `landAt` (s), puis immobile jusqu'à `end` (s).
function track(landAt: number, end: number): IgcFix[] {
  const m = 1 / 111_320;
  const fixes: IgcFix[] = [];
  for (let t = 0; t <= end; t++) {
    const flying = t < landAt;
    const y = Math.min(t, landAt) * 10;
    const alt = flying ? 1500 - t : 1500 - landAt;
    fixes.push({ time: t * 1000, lat: 45 + y * m, lon: 6, gnssAltitude: alt, pressureAltitude: alt, valid: true });
  }
  return fixes;
}

describe("posé juste avant la fin de la trace", () => {
  it("une trace qui s'arrête 30 s après le posé est posée, au fix du posé", () => {
    const [f] = detectFlights(track(600, 630));
    expect(f!.landed).toBe(true);
    expect(f!.landingIndex).toBe(600);
  });

  it("une trace qui s'arrête en vol, ou moins de 20 s après le posé, ne l'est pas", () => {
    expect(detectFlights(track(700, 700))[0]!.landed).toBe(false);
    expect(detectFlights(track(600, 610))[0]!.landed).toBe(false);
  });
});

describe("goal en ligne frôlé au posé (US Open Chelan 2026, manche 1)", () => {
  // Le pilote passe à côté de la ligne (206 m du centre pour une ligne de 200 m), fait le tour et se pose
  // derrière elle, dans le demi-cercle à 103 m du centre (rayon 100 m, tolérance 5 m), après 2 s à 2,2 m/s
  // au ras du sol. La trace s'arrête 31 s plus tard : avant, aucun posé n'était vu et le goal était validé
  // à 23:09:53 par le segment 23:09:52 → 23:09:53, au sol (S7F 9.2.3.1 : le premier fix doit être en vol).
  const task = parseXctskQr(fixture("us-open-chelan-2026-t1.qr.txt").trim());
  const flight = parseIgc(fixture("us-open-chelan-2026-t1-goal-pose.igc"));
  const c = controlFlight(task, flight.fixes);

  it("le posé est à 23:09:51, à la fin du dernier segment rapide", () => {
    expect(new Date(c.landingTime!).toISOString()).toBe("2026-06-21T23:09:51.000Z");
  });

  it("ESS validé, goal non validé, à 110 m près de la distance de la manche", () => {
    expect(c.madeEss).toBe(true);
    expect(c.madeGoal).toBe(false);
    expect(c.flownDistance).toBeGreaterThan(taskDistances(task).task - 110);
  });
});
