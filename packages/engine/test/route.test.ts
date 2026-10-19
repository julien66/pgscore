import { describe, expect, it } from "vitest";
import { findTaskAreaCentre } from "../src/projection.js";
import { bestPointOnCircle, optimizeRoute, RouteFrom, type RouteZone } from "../src/route.js";

// Petite manche alpine : trois cylindres et un goal, autour de Gemona.
const zones: RouteZone[] = [
  { centre: { lat: 46.27, lon: 13.13 }, radius: 3000 },
  { centre: { lat: 46.35, lon: 12.95 }, radius: 1000 },
  { centre: { lat: 46.2, lon: 12.8 }, radius: 5000 },
  { centre: { lat: 46.3, lon: 13.25 }, radius: 400 },
];

describe("RouteFrom", () => {
  it("donne la même distance qu'optimizeRoute, fix après fix", () => {
    const centre = findTaskAreaCentre(zones.map((z) => z.centre));
    const from = new RouteFrom(zones, centre);
    for (let i = 0; i <= 400; i++) {
      // Trajet en zigzag, avec des pas de quelques mètres puis des sauts.
      const p = { lat: 46.25 + 0.0001 * i + (i % 50 === 0 ? 0.01 : 0), lon: 13.0 + 0.00005 * (i % 7) };
      const ref = optimizeRoute([{ centre: p, radius: 0 }, ...zones], centre).distance;
      expect(Math.abs(from.distance(p) - ref)).toBeLessThan(0.005);
    }
  });
});

describe("bestPointOnCircle", () => {
  it("trouve le minimum de |a−p| + |p−b| sur le cercle", () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let k = 0; k < 300; k++) {
      const c = { x: rnd() * 1000, y: rnd() * 1000 };
      const r = 10 + Math.abs(rnd()) * 3000;
      const a = { x: rnd() * 20000, y: rnd() * 20000 };
      const b = { x: rnd() * 20000, y: rnd() * 20000 };
      const len = (p: { x: number; y: number }) => Math.hypot(a.x - p.x, a.y - p.y) + Math.hypot(b.x - p.x, b.y - p.y);
      let best = Infinity;
      for (let i = 0; i < 20000; i++) {
        const t = (i / 20000) * 2 * Math.PI;
        best = Math.min(best, len({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }));
      }
      expect(len(bestPointOnCircle(a, b, c, r))).toBeLessThanOrEqual(best + 1e-6);
    }
  });
});
