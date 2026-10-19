import { describe, expect, it } from "vitest";
import { parseIgc, writeIgc } from "../src/igc.js";

const sample = [
  "AXCT0011a2b3c4d",
  "HFDTEDATE:051026,01",
  "HFPLTPILOTINCHARGE:Jane Pilot",
  "HFGTYGLIDERTYPE:Enzo 3",
  "HFCIDCOMPETITIONID:711",
  "B1500003737877S04058085WA0060000612",
  "B1500203737900S04058000WA0061500628",
  "B2359593737900S04058000WA0061500628",
  "B0000013737900S04058000WA0061500628",
  "Gabcdef",
].join("\r\n");

describe("lecture IGC", () => {
  const flight = parseIgc(sample);

  it("lit les en-têtes", () => {
    expect(flight.header.date).toBe("2026-10-05");
    expect(flight.header.pilot).toBe("Jane Pilot");
    expect(flight.header.competitionId).toBe("711");
    expect(flight.hasSignature).toBe(true);
  });

  it("lit les points, hémisphère sud et ouest", () => {
    const f = flight.fixes[0]!;
    expect(f.time).toBe(Date.parse("2026-10-05T15:00:00Z"));
    expect(f.lat).toBeCloseTo(-(37 + 37.877 / 60), 6);
    expect(f.lon).toBeCloseTo(-(40 + 58.085 / 60), 6);
    expect(f.pressureAltitude).toBe(600);
    expect(f.gnssAltitude).toBe(612);
  });

  it("gère le passage de minuit UTC", () => {
    expect(flight.fixes[3]!.time).toBe(Date.parse("2026-10-06T00:00:01Z"));
  });

  it("réécrit un IGC relisible à l'identique", () => {
    const again = parseIgc(writeIgc({ header: flight.header, fixes: flight.fixes, sources: ["test"] }));
    expect(again.fixes).toEqual(flight.fixes);
    expect(again.hasSignature).toBe(false);
  });
});
