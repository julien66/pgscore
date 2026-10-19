// Carte de la manche : cylindres (couleur selon le rôle), ligne de goal, route optimisée avec la
// longueur de chaque branche. Mêmes données que la vue des traces.
(function () {
  "use strict";
  const el = document.getElementById("task-map");
  if (!el || !window.L) return;
  const G = JSON.parse(document.getElementById("task-geometry").textContent);
  const ROLE = { takeoff: "Décollage", sss: "Départ", turnpoint: "Balise", ess: "ESS", goal: "Goal" };
  const color = { takeoff: "#6b7280", sss: "#16a34a", turnpoint: "#2563eb", ess: "#9333ea", goal: "#dc2626" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const km = (m) => (m / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25 });
  // Vue initiale sur les balises : Leaflet en a besoin pour calculer l'emprise des cylindres.
  map.fitBounds(L.latLngBounds(G.zones.map((z) => [z.lat, z.lon])).pad(0.1));
  pgBasemaps.add(map);
  const bounds = [];
  for (const z of G.zones) {
    const c = color[z.role] || "#2563eb";
    const label = `${z.index + 1}. ${ROLE[z.role] || z.role} ${esc(z.name)}`;
    if (z.line) {
      L.polyline([[z.line.a.lat, z.line.a.lon], [z.line.b.lat, z.line.b.lon]], { color: c, weight: 5 }).bindTooltip(`${label} · ligne de ${Math.round(z.radius * 2)} m`).addTo(map);
      L.polyline(z.line.semicircle.map((p) => [p.lat, p.lon]), { color: c, weight: 1, dashArray: "4 4" }).addTo(map);
    } else {
      const circle = L.circle([z.lat, z.lon], { radius: z.radius, color: c, weight: 2, fillOpacity: z.role === "sss" ? 0 : 0.08 })
        .bindTooltip(`${label} · ${km(z.radius)} km`)
        .addTo(map);
      bounds.push(circle.getBounds());
    }
  }
  // Numéros des zones sur les balises ; plusieurs zones sur la même balise (départ et balise, ESS et goal) partagent une pastille.
  const spots = new Map();
  for (const z of G.zones) {
    const k = `${z.lat.toFixed(5)},${z.lon.toFixed(5)}`;
    if (!spots.has(k)) spots.set(k, []);
    spots.get(k).push(z);
  }
  for (const zs of spots.values()) {
    const z = zs[zs.length - 1];
    const c = color[z.role] || "#2563eb";
    const text = zs.map((x) => x.index + 1).join("·");
    const w = Math.max(22, 10 + 8 * text.length);
    L.marker([z.lat, z.lon], {
      icon: L.divIcon({ className: "tm-num", html: `<span style="background:${c}">${text}</span>`, iconSize: [w, 22], iconAnchor: [w / 2, 11] }),
      keyboard: false,
    }).bindTooltip(zs.map((x) => `${x.index + 1}. ${ROLE[x.role] || x.role} ${esc(x.name)}`).join("<br>")).addTo(map);
  }
  // Route optimisée, avec la longueur de chaque branche au milieu.
  const pts = G.route.map((p) => [p.lat, p.lon]);
  L.polyline(pts, { color: "#111827", weight: 2.5, opacity: 0.85 }).addTo(map);
  const legLabels = G.legs.map((d, i) => {
    const a = pts[i], b = pts[i + 1];
    return {
      a, b,
      // Aux 40 % de la branche : un aller-retour sur le même trajet n'empile pas ses deux étiquettes.
      m: L.marker([a[0] + 0.4 * (b[0] - a[0]), a[1] + 0.4 * (b[1] - a[1])], {
        icon: L.divIcon({ className: "tm-leg", html: `<span>${km(d)} km</span>`, iconSize: [64, 18], iconAnchor: [32, 9] }),
        interactive: false,
      }),
    };
  });
  // Longueur affichée seulement si la branche est assez longue à l'écran pour la porter.
  const showLegs = () => {
    for (const l of legLabels) {
      const px = map.latLngToLayerPoint(l.a).distanceTo(map.latLngToLayerPoint(l.b));
      if (px > 90) l.m.addTo(map); else l.m.remove();
    }
  };
  map.on("zoomend", showLegs);
  for (const p of pts) L.circleMarker(p, { radius: 3, color: "#111827", fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(map);
  const all = L.latLngBounds(pts);
  bounds.forEach((b) => all.extend(b));
  map.fitBounds(all.pad(0.04));
  showLegs();
})();
