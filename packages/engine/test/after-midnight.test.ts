import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { controlFlight, parseIgc, parseXctskQr, taskSeconds } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("heures UTC d'une manche qui passent minuit (US Open Chelan 2026, manche 1)", () => {
  // Porte à 20:00 UTC, deadline à 01:30 UTC le lendemain (13:00 et 18:30 heure du Pacifique).
  const task = parseXctskQr(fixture("us-open-chelan-2026-t1.qr.txt").trim());

  it("la deadline est le lendemain de la porte", () => {
    expect(task.deadline).toBe("01:30:00");
    expect(taskSeconds(task, task.deadline!)).toBe(86_400 + 5400);
    expect(taskSeconds(task, task.startGates[0]!)).toBe(20 * 3600);
  });

  it("un pilote qui part après la porte est contrôlé (avant : aucun départ, 5 km au minimum)", () => {
    const flight = parseIgc(fixture("us-open-chelan-2026-t1-24.igc"));
    const c = controlFlight(task, flight.fixes);
    expect(c.sssTime).not.toBeNull();
    expect(c.sssTime!).toBeGreaterThanOrEqual(Date.parse("2026-06-21T20:00:00Z"));
    expect(c.flownDistance).toBeGreaterThan(20_000);
  });
});
