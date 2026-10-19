// Fonds de carte communs à la carte de la manche et à la vue des traces. Le choix est retenu dans
// le navigateur. Par défaut « Relief » : ombrage gris et noms de lieux ; « Topo gris » : OpenTopoMap en niveaux de gris,
// pour que cylindres, routes et traces en couleur ressortent.
(function () {
  "use strict";
  const OSM = '&copy; contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const TOPO = { url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", opts: { maxZoom: 17, subdomains: "abc", attribution: `${OSM}, SRTM · style <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)` } };
  // Chaque fond est une ou plusieurs couches superposées ; grey = affichée en niveaux de gris.
  const BASES = {
    "Topo gris": [{ ...TOPO, grey: true }],
    "Topo": [TOPO],
    "Relief": [
      { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}", opts: { maxZoom: 16, maxNativeZoom: 16, attribution: "Relief &copy; Esri, USGS" } },
      { url: "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png", opts: { maxZoom: 18, subdomains: "abcd", attribution: `${OSM} · &copy; <a href="https://carto.com/attributions">CARTO</a>` } },
    ],
    "Plan": [{ url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", opts: { maxZoom: 19, attribution: OSM } }],
    "Satellite": [{ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", opts: { maxZoom: 18, attribution: "Imagerie &copy; Esri, Maxar, Earthstar Geographics" } }],
  };
  const DEFAULT = "Relief";
  const KEY = "pgscore.basemap";
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const style = document.createElement("style");
  style.textContent = ".tiles-grey{filter:grayscale(1) contrast(.9) brightness(1.06)}";
  document.head.appendChild(style);
  window.pgBasemaps = {
    BASES,
    /** Ajoute les fonds de carte et le sélecteur à une carte Leaflet. */
    add(map) {
      const layers = Object.fromEntries(
        Object.entries(BASES).map(([name, parts]) => [
          name,
          L.layerGroup(parts.map((b) => L.tileLayer(b.url, { ...b.opts, ...(b.grey ? { className: "tiles-grey" } : {}) }))),
        ]),
      );
      const first = layers[saved()] ? saved() : DEFAULT;
      layers[first].addTo(map);
      L.control.layers(layers, null, { position: "topright" }).addTo(map);
      map.on("baselayerchange", (e) => { try { localStorage.setItem(KEY, e.name); } catch {} });
      return layers;
    },
    /** Fond choisi, pour la vue 3D (Cesium). */
    current() { return BASES[saved()] ? saved() : DEFAULT; },
  };
})();
