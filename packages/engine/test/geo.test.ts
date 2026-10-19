import { describe, expect, it } from "vitest";
import { direct, distance, inverse } from "../src/geo.js";

describe("géodésie WGS84", () => {
  it("un degré de longitude à l'équateur vaut a·π/180", () => {
    expect(distance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo((6378137 * Math.PI) / 180, 3);
  });

  it("un degré de latitude depuis l'équateur vaut 110 574,389 m", () => {
    expect(distance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(110574.389, 2);
  });

  it("direct puis inverse retombe sur la même distance", () => {
    const a = { lat: -19.63129, lon: -40.96808 };
    const b = direct(a, 77.5, 16123.4);
    const r = inverse(a, b);
    expect(r.distance).toBeCloseTo(16123.4, 6);
    expect(r.azimuth1).toBeCloseTo(77.5, 9);
  });
});
