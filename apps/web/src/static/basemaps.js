// Fonds de carte communs à la carte de la manche et à la vue des traces.
// Par défaut OpenTopoMap (courbes de niveau, relief) ; plan OSM et satellite au choix.
// Le choix est retenu dans le navigateur.
(function () {
  "use strict";
  const OSM = '&copy; contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const BASES = {
    "Topo": {
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      opts: { maxZoom: 17, subdomains: "abc", attribution: `${OSM}, SRTM · style <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)` },
    },
    "Plan": { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", opts: { maxZoom: 19, attribution: OSM } },
    "Satellite": {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      opts: { maxZoom: 18, attribution: "Imagerie &copy; Esri, Maxar, Earthstar Geographics" },
    },
  };
  const KEY = "pgscore.basemap";
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  window.pgBasemaps = {
    BASES,
    /** Ajoute les fonds de carte et le sélecteur à une carte Leaflet. */
    add(map) {
      const layers = Object.fromEntries(Object.entries(BASES).map(([name, b]) => [name, L.tileLayer(b.url, b.opts)]));
      const first = layers[saved()] ? saved() : "Topo";
      layers[first].addTo(map);
      L.control.layers(layers, null, { position: "topright" }).addTo(map);
      map.on("baselayerchange", (e) => { try { localStorage.setItem(KEY, e.name); } catch {} });
      return layers;
    },
    /** Fond choisi, pour la vue 3D (Cesium). */
    current() { return BASES[saved()] ? saved() : "Topo"; },
  };
})();
