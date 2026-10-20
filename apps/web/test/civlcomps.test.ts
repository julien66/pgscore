import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { civlResultsUrl, civlToArchive, eventDates, parseEventPage, parseTaskPage, pilotForTrack, startTimes } from "../src/civlcomps.js";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

describe("import civlcomps.org", () => {
  it("reconnaît l'adresse de l'événement", () => {
    expect(civlResultsUrl("https://civlcomps.org/event/german-open-2026/info")).toBe("https://civlcomps.org/event/german-open-2026/results");
    expect(() => civlResultsUrl("https://example.org/event/x")).toThrow();
    expect(() => civlResultsUrl("pas une adresse")).toThrow();
  });

  it("lit les dates et les heures de départ", () => {
    expect(eventDates("Sep 14 - Sep 20, 2026")).toEqual({ start: "2026-09-14", end: "2026-09-20" });
    expect(eventDates("Dec 28, 2025 - Jan 3, 2026")).toEqual({ start: "2025-12-28", end: "2026-01-03" });
    expect(startTimes("Task is set 60 km. Start at 12:00. Task deadline at 16:30.")).toEqual(["12:00:00"]);
    expect(startTimes("Start at 12:00, every 15 min, 3 gates. Task deadline at 16:30.")).toEqual(["12:00:00", "12:15:00", "12:30:00"]);
  });

  it("lit la page de l'événement", () => {
    const e = parseEventPage(fx("civlcomps-event.html"));
    expect(e.name).toBe("French Open - Trophées des Cimes 2026");
    expect(e.start_date).toBe("2026-06-13");
    expect(e.tasks).toHaveLength(1);
    expect(e.tasks[0]).toMatchObject({ date: "2026-06-16", label: "Task 3", type: "race" });
    expect(e.tasks[0]!.igcUrl).toMatch(/download-file\?filename=/);
    expect(e.tasks[0]!.results[0]!.label).toBe("Overall");
  });

  it("lit la page de résultats d'une manche arrêtée", () => {
    const p = parseTaskPage(fx("civlcomps-task.html"));
    expect(p.turnpoints).toHaveLength(10);
    expect(p.turnpoints[1]).toMatchObject({ label: "2SS", name: "D34170", radius: 1000, open: "12:00:00" });
    expect(p.stop).toEqual({ time: "13:56:00", scoreBackMinutes: 5 });
    expect(p.utcOffset).toBe(120);
    expect(p.formula.nom_dist).toBe("50");
    expect(p.penalties).toEqual([{ key: "1", name: "Honorin Hamard", percent: 0, points: 1000, reason: "251 m dans VAC Altiport Peyresourde" }]);
    expect(p.pilots[0]).toMatchObject({ key: "37", name: "Michel Cervellin", gender: "M", nation: "FRA", rank: "1" });
  });

  it("retrouve le pilote d'une trace", () => {
    const pilots = new Map([
      ["7", "Boris Kosog"],
      ["60", "Adrien Raisson"],
      ["58008", "Andreas Häger"],
    ]);
    expect(pilotForTrack("7_Boris_Kosog.igc", pilots)).toBe("7");
    expect(pilotForTrack("T03/LiveTrack Adrien Raisson..20260616-082855.60845.60.igc", pilots)).toBe("60");
    expect(pilotForTrack("T03/LiveTrack Andreas H#U00e4ger..20260616.igc", pilots)).toBe("58008");
    expect(pilotForTrack("Inconnu.igc", pilots)).toBeNull();
  });

  it("construit l'archive : manche en UTC, pénalités, traces", async () => {
    const event = fx("civlcomps-event.html");
    const task = fx("civlcomps-task.html");
    const zip = zipSync({ "T03/LiveTrack Michel Cervellin..20260616.1.37.igc": strToU8("AXXX\n"), "T03/LiveTrack Personne..x.igc": strToU8("A\n") });
    const fetcher = async (url: string) => (url.includes("download-file") ? zip : strToU8(url.endsWith("/results") ? event : task));
    const { a, warnings } = await civlToArchive("https://civlcomps.org/event/french-open-trophees-des-cimes-2026/results", fetcher);
    expect(a.competition.settings).toMatchObject({ nominalDistance: 50000, minimumDistance: 7000, ftvFactor: 0.25, gapProfile: "S7F2026", timeZone: "Etc/GMT-2" });
    const tk = a.tasks[0]!;
    expect(tk.task.startGates).toEqual(["10:00:00"]);
    expect(tk.task.stopAnnouncement).toBe("11:56:00");
    expect(tk.task.turnpoints.map((x) => x.role)).toEqual(["takeoff", "sss", "turnpoint", "turnpoint", "turnpoint", "turnpoint", "turnpoint", "turnpoint", "ess", "goal"]);
    expect(tk.decisions.find((d) => d.kind === "penalty")).toMatchObject({ pilot_key: "1", value: 1000 });
    expect(tk.tracks.map((x) => x.pilot_key)).toEqual(["37"]);
    expect(warnings.join(" ")).toMatch(/1 traces du ZIP/);
  });
});
