// Fonds de carte communs à la carte de la manche et à la vue des traces. Le choix est retenu dans
// le navigateur. Par défaut « Relief » : ombrage gris et noms de lieux ; « Topo gris » : OpenTopoMap en niveaux de gris,
// pour que cylindres, routes et traces en couleur ressortent.
(function () {
  "use strict";
  const OSM = T("&copy; contributeurs {osm}", { osm: '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
  const TOPO = { url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", opts: { maxZoom: 17, subdomains: "abc", attribution: `${OSM}, SRTM · ${T("style {name}", { name: '<a href="https://opentopomap.org">OpenTopoMap</a>' })} (CC-BY-SA)` } };
  // Chaque fond est une ou plusieurs couches superposées ; grey = affichée en niveaux de gris.
  const BASES = {
    "Topo gris": [{ ...TOPO, grey: true }],
    "Topo": [TOPO],
    "Relief": [
      { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}", opts: { maxZoom: 16, maxNativeZoom: 16, attribution: T("Relief &copy; {src}", { src: "Esri, USGS" }) } },
      // Noms de lieux Esri (le fond « labels » de CARTO exige désormais une clé).
      { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", opts: { maxZoom: 18, maxNativeZoom: 16, attribution: T("Noms &copy; {src}", { src: "Esri, HERE, Garmin" }) } },
    ],
    "Plan": [{ url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", opts: { maxZoom: 19, attribution: OSM } }],
    "Satellite": [{ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", opts: { maxZoom: 18, attribution: T("Imagerie &copy; {src}", { src: "Esri, Maxar, Earthstar Geographics" }) } }],
  };
  // Noms affichés dans le sélecteur ; les clés de BASES (retenues dans le navigateur) restent fixes.
  const LABEL = { "Topo gris": T("Topo gris"), "Topo": T("Topo"), "Relief": T("Relief"), "Plan": T("Plan"), "Satellite": T("Satellite") };
  const label = (id) => LABEL[id] || id;
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
      const shownLayers = Object.fromEntries(Object.entries(layers).map(([id, layer]) => [label(id), layer]));
      L.control.layers(shownLayers, null, { position: "topright" }).addTo(map);
      map.on("baselayerchange", (e) => {
        const id = Object.keys(layers).find((k) => layers[k] === e.layer) || e.name;
        try { localStorage.setItem(KEY, id); } catch {}
      });
      return layers;
    },
    /** Fond choisi, pour la vue 3D (Cesium). */
    current() { return BASES[saved()] ? saved() : DEFAULT; },
  };
})();
