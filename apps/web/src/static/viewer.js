// Vue d'une trace : carte 2D (Leaflet), barogramme, lecture dans le temps et vue 3D (Cesium).
// Les distances affichées viennent du serveur (ellipsoïde WGS84), comme le contrôle.
(function () {
  "use strict";
  const root = document.getElementById("viewer");
  const D = JSON.parse(document.getElementById("viewer-data").textContent);
  const tz = D.timeZone;
  // Versions de la trace : celle en vigueur d'abord. Numérotées dans l'ordre de réception (v1 = la première reçue).
  const VS = D.versions;
  const COLORS = ["#0ea5e9", "#f97316", "#a855f7", "#10b981", "#e11d48", "#ca8a04"];
  [...VS].sort((a, b) => a.uploadedAt - b.uploadedAt).forEach((v, k) => (v.num = k + 1));
  VS.forEach((v, k) => (v.color = COLORS[k % COLORS.length]));
  const multi = VS.length > 1;
  const want = new URLSearchParams(location.search).get("v");
  let cur = Math.max(0, VS.findIndex((v) => v.sha256 === want));
  const shown = new Set(VS.map((_, k) => k));
  // Version analysée : ses données sont reliées à ces variables par bind().
  let V, TK, N, above;

  // ---- Formats ----------------------------------------------------------------------------
  const LOC = window.I18N_LOCALE || "fr-FR";
  const fmtTime = new Intl.DateTimeFormat(LOC, { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const hhmmss = (t) => (t == null ? "" : fmtTime.format(new Date(t)));
  const m = (x, d = 0) => (x == null ? "–" : x.toLocaleString(LOC, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const km = (x) => (x == null ? "–" : (x / 1000).toLocaleString(LOC, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const ROLE = { takeoff: T("Décollage"), sss: T("Départ"), turnpoint: T("Balise"), ess: "ESS", goal: "Goal" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const edgeText = (e) => (e == null ? "–" : e >= 0 ? T("{d} m dehors", { d: m(e, 1) }) : T("{d} m dedans", { d: m(-e, 1) }));

  // ---- Géométrie côté client (affichage seulement) -----------------------------------------
  function inPolygon(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      if (a.lat > lat !== b.lat > lat && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
    }
    return inside;
  }
  const bboxes = D.airspaces.map((a) => {
    const la = a.polygon.map((p) => p.lat), lo = a.polygon.map((p) => p.lon);
    return { s: Math.min(...la), n: Math.max(...la), w: Math.min(...lo), e: Math.max(...lo) };
  });
  // Espaces aériens au-dessus ou au-dessous de chaque fix (contour horizontal seulement), calculés à la demande.
  function aboveOf(v) {
    if (v._above) return v._above;
    const tr = v.track, out = new Array(tr.t.length);
    for (let i = 0; i < tr.t.length; i++) {
      const lat = tr.lat[i], lon = tr.lon[i];
      const list = [];
      D.airspaces.forEach((a, k) => {
        const b = bboxes[k];
        if (lat < b.s || lat > b.n || lon < b.w || lon > b.e) return;
        if (inPolygon(lat, lon, a.polygon)) list.push(k);
      });
      out[i] = list;
    }
    return (v._above = out);
  }
  const vLabel = (v) =>
    v.status === "current" ? T("v{n} (en vigueur)", { n: v.num }) : v.status === "replaced" ? T("v{n} (remplacée)", { n: v.num }) : T("v{n} (retirée)", { n: v.num });
  function bind(k) {
    cur = k; V = VS[k]; TK = V.track; N = TK.t.length; above = aboveOf(V);
  }
  bind(cur);

  // ---- Mise en page -----------------------------------------------------------------------
  root.innerHTML = `
    <div class="v-top">
      <div class="v-tabs"><button data-mode="2d" class="on">${T("Carte 2D")}</button><button data-mode="3d">${T("Vue 3D")}</button></div>
      <div class="v-play">
        <button id="v-prev" title="${esc(T("Fix précédent"))}">◀</button>
        <button id="v-play" title="${esc(T("Lecture"))}">▶</button>
        <button id="v-next" title="${esc(T("Fix suivant"))}">▶︎|</button>
        <select id="v-speed" title="${esc(T("Vitesse de lecture"))}"><option value="10">×10</option><option value="30" selected>×30</option><option value="100">×100</option><option value="300">×300</option></select>
        <input id="v-slider" type="range" min="0" max="${N - 1}" value="${TK.flightStart}" />
      </div>
    </div>
    ${multi ? `<div class="v-box"><h3>${T("Versions de la trace")}</h3><div class="scroll"><table class="v-versions" id="v-versions"></table></div>
      <p class="small muted">${T("Cochez « Afficher » pour superposer les traces ; « Analyser » choisit la version dont le contrôle est détaillé. Un clic sur une trace de la carte l'analyse aussi.")}</p></div>` : ""}
    <div class="v-main">
      <div class="v-maps"><div id="v-map"></div><div id="v-3d" hidden></div></div>
      <aside class="v-side">
        <div id="v-now" class="v-box"></div>
        <div class="v-box"><h3 id="v-ctl-title">${T("Contrôle")}</h3><ol id="v-events" class="v-events"></ol></div>
      </aside>
    </div>
    <canvas id="v-baro" height="170"></canvas>`;

  const slider = document.getElementById("v-slider");
  let idx = TK.flightStart;

  // ---- Liste des événements ------------------------------------------------------------------
  let events = [];
  const evList = document.getElementById("v-events");
  function renderEvents() {
  events = [];
  const D = V;
  for (const v of D.validations) events.push({ t: v.time, html: T("{zone} validé à {time}", { zone: `<b>${ROLE[v.role] || v.role} ${esc(v.name)}</b>`, time: hhmmss(v.time) }), cls: "ok" });
  let firstMiss = true;
  for (const a of D.approaches) {
    if (a.reached) continue;
    if (!a.closest) {
      events.push({ t: Infinity, html: T("{zone} non atteint (pas de vol après la validation précédente)", { zone: `<b>${ROLE[a.role] || a.role} ${esc(a.name)}</b>` }), cls: firstMiss ? "miss" : "later" });
    } else {
      const d = a.closest.distance;
      const where = d >= 0 ? T("{d} m à l'extérieur du cylindre", { d: m(d, 1) }) : T("{d} m à l'intérieur du cylindre", { d: m(-d, 1) });
      const what = a.role === "sss" ? T("Départ manqué") : T("{zone} non validé", { zone: `${ROLE[a.role] || a.role} ${esc(a.name)}` });
      events.push({
        t: a.closest.time,
        html: firstMiss
          ? T("{what} : au plus près {where} à {time}, {alt} m. Tolérance : 5 m.", { what: `<b>${what}</b>`, where, time: hhmmss(a.closest.time), alt: m(a.closest.altitude) })
          : `${T("{zone} : au plus près {where} à {time}", { zone: `${ROLE[a.role] || a.role} ${esc(a.name)}`, where, time: hhmmss(a.closest.time) })} <span class="muted">${T("(non compté : zone précédente non validée)")}</span>`,
        cls: firstMiss ? "miss" : "later",
      });
    }
    firstMiss = false;
  }
  for (const i of D.infringements) {
    events.push({
      t: i.worst,
      html: T("{airspace} : {d} m de pénétration de {from} à {to}", { airspace: `<b>${T("Espace aérien {name}", { name: esc(i.name) })}</b>`, d: m(i.depth, 1), from: hhmmss(i.from), to: hhmmss(i.to) }),
      cls: "bad",
    });
  }
  if (D.stopTime) events.push({ t: D.stopTime, html: T("{stop} (après score-back) à {time}", { stop: `<b>${T("Arrêt de la manche")}</b>`, time: hhmmss(D.stopTime) }), cls: "" });
  events.sort((a, b) => a.t - b.t);
  evList.innerHTML = events
    .map((e, k) => `<li class="${e.cls}" data-k="${k}">${e.html}</li>`)
    .join("") || `<li>${T("Rien à signaler.")}</li>`;
  document.getElementById("v-ctl-title").textContent = multi ? T("Contrôle · {version}", { version: vLabel(V) }) : T("Contrôle");
  }
  evList.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-k]");
    if (!li) return;
    const e = events[Number(li.dataset.k)];
    if (Number.isFinite(e.t)) setIndex(indexAt(e.t), true);
  });
  function indexIn(tr, t) {
    let lo = 0, hi = tr.t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tr.t[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  const indexAt = (t) => indexIn(TK, t);

  // ---- Carte 2D -----------------------------------------------------------------------------
  const map = L.map("v-map", { preferCanvas: true });
  pgBasemaps.add(map);
  const color = { takeoff: "#6b7280", sss: "#16a34a", turnpoint: "#2563eb", ess: "#9333ea", goal: "#dc2626" };
  for (const a of D.airspaces) {
    L.polygon(a.polygon.map((p) => [p.lat, p.lon]), { color: "#dc2626", weight: 1, fillOpacity: 0.12 })
      .bindTooltip(`${esc(a.name)} (${esc(a.class)})<br>${esc(a.lowerText)} → ${esc(a.upperText)}<br>${m(a.lower)} → ${m(a.upper)} m AMSL`)
      .addTo(map);
  }
  for (const z of D.zones) {
    const c = color[z.role] || "#2563eb";
    if (z.line) {
      L.polyline([[z.line.a.lat, z.line.a.lon], [z.line.b.lat, z.line.b.lon]], { color: c, weight: 4 }).addTo(map);
      L.polyline(z.line.semicircle.map((p) => [p.lat, p.lon]), { color: c, weight: 1, dashArray: "4 4" }).addTo(map);
    } else {
      L.circle([z.lat, z.lon], { radius: z.radius, color: c, weight: 2, fill: z.role !== "sss", fillOpacity: 0.05 })
        .bindTooltip(`${z.index + 1}. ${ROLE[z.role] || z.role} ${esc(z.name)} · ${m(z.radius)} m`)
        .addTo(map);
    }
  }
  L.polyline(D.route.map((p) => [p.lat, p.lon]), { color: "#111827", weight: 1.5, dashArray: "6 6", opacity: 0.7 }).addTo(map);
  const ll = (i) => [TK.lat[i], TK.lon[i]];
  // Traces de toutes les versions ; la version analysée est en trait plein, les autres en pointillé.
  const trackLayers = VS.map((v, k) => {
    const tr = v.track, g = L.layerGroup();
    const pts = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push([tr.lat[i], tr.lon[i]]); return o; };
    g.outside = [L.polyline(pts(0, tr.flightStart), { color: "#9ca3af", weight: 2 }), L.polyline(pts(tr.flightEnd, tr.t.length - 1), { color: "#9ca3af", weight: 2 })];
    g.line = L.polyline(pts(tr.flightStart, tr.flightEnd), { color: v.color, weight: 2.5 }).bindTooltip(multi ? vLabel(v) : D.pilot.name, { sticky: true });
    g.line.on("click", (e) => {
      if (k !== cur) return selectVersion(k);
      // Clic sur la trace analysée : fix le plus proche du clic.
      let best = 0, bd = Infinity;
      for (let i = TK.flightStart; i <= TK.flightEnd; i++) {
        const d = (TK.lat[i] - e.latlng.lat) ** 2 + ((TK.lon[i] - e.latlng.lng) * Math.cos((e.latlng.lat * Math.PI) / 180)) ** 2;
        if (d < bd) (bd = d), (best = i);
      }
      setIndex(best);
    });
    g.ghost = L.circleMarker([0, 0], { radius: 5, color: v.color, fillColor: "#fff", fillOpacity: 1, weight: 3 });
    return g;
  });
  const markers = L.layerGroup().addTo(map);
  function drawTracks2d() {
    VS.forEach((v, k) => {
      const g = trackLayers[k];
      g.clearLayers();
      if (!shown.has(k) && k !== cur) return g.remove();
      const active = k === cur;
      g.line.setStyle({ weight: active ? 3 : 2, opacity: active ? 1 : 0.85, dashArray: active ? null : "6 5" });
      g.addLayer(g.line);
      if (active) g.outside.forEach((x) => g.addLayer(x));
      else g.addLayer(g.ghost);
      g.addTo(map);
      if (active) g.line.bringToFront();
    });
    markers.clearLayers();
    for (const v of V.validations) {
      const i = indexAt(v.time);
      L.circleMarker(ll(i), { radius: 6, color: "#16a34a", fillColor: "#16a34a", fillOpacity: 1 })
        .bindTooltip(T("{zone} validé à {time}", { zone: `${ROLE[v.role] || v.role} ${esc(v.name)}`, time: hhmmss(v.time) }))
        .addTo(markers);
    }
    for (const a of V.approaches) {
      if (a.reached || !a.closest) continue;
      L.circleMarker([a.closest.lat, a.closest.lon], { radius: 6, color: "#ea580c", fillColor: "#fff", fillOpacity: 1, weight: 3 })
        .bindTooltip(T("{zone} : au plus près {where} à {time}", { zone: `${ROLE[a.role] || a.role} ${esc(a.name)}`, where: edgeText(a.closest.distance), time: hhmmss(a.closest.time) }))
        .addTo(markers);
    }
    for (const i of V.infringements) {
      const k = indexAt(i.worst);
      L.circleMarker(ll(k), { radius: 6, color: "#dc2626", fillColor: "#dc2626", fillOpacity: 1 })
        .bindTooltip(`${esc(i.name)} : ${m(i.depth, 1)} m`)
        .addTo(markers);
    }
  }
  // Position des autres versions au même instant.
  function moveGhosts2d(t) {
    VS.forEach((v, k) => {
      if (k === cur || !shown.has(k)) return;
      const tr = v.track, g = trackLayers[k];
      if (t < tr.t[0] || t > tr.t[tr.t.length - 1]) return g.ghost.setStyle({ opacity: 0, fillOpacity: 0 });
      const j = indexIn(tr, t);
      g.ghost.setLatLng([tr.lat[j], tr.lon[j]]).setStyle({ opacity: 1, fillOpacity: 1 });
    });
  }
  drawTracks2d();
  const cursor = L.circleMarker(ll(idx), { radius: 7, color: "#111827", fillColor: "#facc15", fillOpacity: 1, weight: 2 }).addTo(map);
  {
    const b = [...D.zones.map((z) => [z.lat, z.lon])];
    for (const v of VS) for (let i = v.track.flightStart; i <= v.track.flightEnd; i += 10) b.push([v.track.lat[i], v.track.lon[i]]);
    map.fitBounds(L.latLngBounds(b).pad(0.05));
  }

  // ---- Barogramme ---------------------------------------------------------------------------
  const baro = document.getElementById("v-baro");
  const ctx = baro.getContext("2d");
  // Échelle commune à toutes les versions, pour que les barogrammes se superposent.
  const span = (tr) => [Math.max(0, tr.flightStart - 60), Math.min(tr.t.length - 1, tr.flightEnd + 60)];
  let t0 = Infinity, t1 = -Infinity, aMin = Infinity, aMax = -Infinity;
  for (const v of VS) {
    const tr = v.track, [a, b] = span(tr);
    t0 = Math.min(t0, tr.t[a]); t1 = Math.max(t1, tr.t[b]);
    for (let i = a; i <= b; i++) if (tr.alt[i] != null) (aMin = Math.min(aMin, tr.alt[i])), (aMax = Math.max(aMax, tr.alt[i]));
  }
  aMin = Math.max(-100, Math.floor((aMin - 150) / 100) * 100);
  aMax = Math.ceil((aMax + 300) / 100) * 100;
  let i0 = 0, i1 = 0;
  const PAD = { l: 48, r: 10, t: 8, b: 20 };
  const css = getComputedStyle(document.documentElement);
  function drawBaro() {
    const w = (baro.width = baro.clientWidth * devicePixelRatio);
    const h = (baro.height = 170 * devicePixelRatio);
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const W = w / devicePixelRatio, H = h / devicePixelRatio;
    const x = (t) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (a) => PAD.t + (1 - (a - aMin) / (aMax - aMin)) * (H - PAD.t - PAD.b);
    ctx.clearRect(0, 0, W, H);
    [i0, i1] = span(TK);
    const text = css.getPropertyValue("--muted") || "#666";
    ctx.font = "11px system-ui";
    ctx.fillStyle = text;
    ctx.strokeStyle = css.getPropertyValue("--line") || "#ddd";
    const step = (aMax - aMin) > 2500 ? 500 : 200;
    for (let a = Math.ceil(aMin / step) * step; a <= aMax; a += step) {
      ctx.beginPath(); ctx.moveTo(PAD.l, y(a)); ctx.lineTo(W - PAD.r, y(a)); ctx.stroke();
      ctx.fillText(`${a} m`, 4, y(a) + 4);
    }
    // Espaces aériens sous la trace : bandes plancher-plafond.
    ctx.fillStyle = "rgba(220,38,38,0.18)";
    for (let i = i0; i <= i1; i++) {
      for (const k of above[i]) {
        const a = D.airspaces[k];
        const top = y(Math.min(a.upper, aMax)), bot = y(Math.max(a.lower, aMin));
        if (bot <= top) continue;
        const xa = x(TK.t[i]), xb = x(TK.t[Math.min(i + 1, N - 1)]);
        ctx.fillRect(xa, top, Math.max(1, xb - xa), bot - top);
      }
    }
    // Portes, arrêt, deadline.
    const vline = (t, col, label) => {
      if (t == null || t < t0 || t > t1) return;
      ctx.strokeStyle = col; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x(t), PAD.t); ctx.lineTo(x(t), H - PAD.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.fillText(label, x(t) + 3, PAD.t + 10);
    };
    D.gates.forEach((g) => vline(g, "#16a34a", T("porte")));
    vline(V.stopTime, "#9333ea", T("arrêt"));
    vline(D.deadline, "#dc2626", T("deadline"));
    // Traces : les autres versions affichées en pointillé, puis la version analysée.
    const plot = (tr, col, width, dash) => {
      const [a, b] = span(tr);
      ctx.strokeStyle = col; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
      let started = false;
      for (let i = a; i <= b; i++) {
        if (tr.alt[i] == null) continue;
        if (!started) ctx.moveTo(x(tr.t[i]), y(tr.alt[i])), (started = true);
        else ctx.lineTo(x(tr.t[i]), y(tr.alt[i]));
      }
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    VS.forEach((v, k) => k !== cur && shown.has(k) && plot(v.track, v.color, 1.2, [5, 4]));
    plot(TK, V.color, 1.6, []);
    for (const v of V.validations) {
      const k = indexAt(v.time);
      if (TK.alt[k] == null) continue;
      ctx.fillStyle = "#16a34a"; ctx.beginPath(); ctx.arc(x(v.time), y(TK.alt[k]), 3.5, 0, 7); ctx.fill();
    }
    // Heures.
    ctx.fillStyle = text;
    const secs = (t1 - t0) / 1000, tick = secs > 4 * 3600 ? 3600e3 : secs > 3600 ? 1800e3 : 600e3;
    for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) ctx.fillText(hhmmss(t).slice(0, 5), x(t) - 14, H - 5);
    // Curseur.
    ctx.strokeStyle = css.getPropertyValue("--text") || "#111"; ctx.beginPath(); ctx.moveTo(x(TK.t[idx]), PAD.t); ctx.lineTo(x(TK.t[idx]), H - PAD.b); ctx.stroke();
    baro._x = x;
  }
  const fromX = (px) => {
    const W = baro.clientWidth;
    const t = t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);
    return Math.min(N - 1, Math.max(0, indexAt(t)));
  };
  let dragging = false;
  baro.addEventListener("mousedown", (e) => { dragging = true; setIndex(fromX(e.offsetX)); });
  addEventListener("mouseup", () => (dragging = false));
  baro.addEventListener("mousemove", (e) => dragging && setIndex(fromX(e.offsetX)));
  addEventListener("resize", drawBaro);

  // ---- Panneau « maintenant » ----------------------------------------------------------------
  const now = document.getElementById("v-now");
  function renderNow() {
    const i = idx, p = Math.max(0, i - 1);
    const dt = (TK.t[i] - TK.t[p]) / 1000 || 1;
    const vz = TK.alt[i] != null && TK.alt[p] != null ? (TK.alt[i] - TK.alt[p]) / dt : null;
    const dx = Math.hypot((TK.lat[i] - TK.lat[p]) * 111195, (TK.lon[i] - TK.lon[p]) * 111195 * Math.cos((TK.lat[i] * Math.PI) / 180));
    const z = D.zones[TK.next[i]];
    const inAir = above[i]
      .map((k) => {
        const a = D.airspaces[k], alt = TK.alt[i];
        let rel = "";
        if (alt != null) rel = alt < a.lower ? T("{d} m sous le plancher", { d: m(a.lower - alt) }) : alt > a.upper ? T("{d} m au-dessus", { d: m(alt - a.upper) }) : T("{inside}, {d} m des limites", { inside: `<b class="bad">${T("dedans")}</b>`, d: m(Math.min(alt - a.lower, a.upper - alt)) });
        return `<li>${esc(a.name)} (${m(a.lower)}–${m(a.upper)} m) : ${rel}</li>`;
      })
      .join("");
    now.innerHTML = `
      <h3>${hhmmss(TK.t[i])}</h3>
      <dl>
        <dt>${T("Altitude GPS")}</dt><dd>${m(TK.alt[i])} m</dd>
        <dt>${T("Vario")}</dt><dd>${vz == null ? "–" : (vz >= 0 ? "+" : "") + m(vz, 1)} m/s</dd>
        <dt>${T("Vitesse sol")}</dt><dd>${m((dx / dt) * 3.6)} km/h</dd>
        <dt>${T("Prochaine zone")}</dt><dd>${z ? `${ROLE[z.role] || z.role} ${esc(z.name)}` : T("manche terminée")}</dd>
        ${z ? `<dt>${T("Bord de la zone")}</dt><dd>${edgeText(TK.edge[i])}</dd>` : ""}
        <dt>${T("Position")}</dt><dd>${TK.lat[i].toFixed(5)}, ${TK.lon[i].toFixed(5)}</dd>
      </dl>
      ${inAir ? `<p class="small">${T("Espaces aériens à la verticale :")}</p><ul class="small">${inAir}</ul>` : ""}
      ${i < TK.flightStart || i > TK.flightEnd ? `<p class="small muted">${T("Hors du vol retenu.")}</p>` : ""}`;
  }

  // ---- Vue 3D (Cesium, chargé à la demande) --------------------------------------------------
  let viewer3d = null, cursor3d = null, lines3d = [], ghosts3d = [], marks3d = [];
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error(T("Chargement impossible : {src}", { src })));
      document.head.appendChild(s);
    });
  }
  async function open3d() {
    if (viewer3d) return;
    const base = "/vendor/cesium/";
    window.CESIUM_BASE_URL = base;
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = base + "Widgets/widgets.css"; document.head.appendChild(link);
    await loadScript(base + "Cesium.js");
    const C = window.Cesium;
    viewer3d = new C.Viewer("v-3d", {
      baseLayer: false,
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false, infoBox: true, selectionIndicator: false,
    });
    // Même fond que la carte 2D : couches superposées, en niveaux de gris si besoin.
    for (const b of pgBasemaps.BASES[pgBasemaps.current()]) {
      const layer = viewer3d.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
        url: b.url, ...(b.opts.subdomains ? { subdomains: b.opts.subdomains } : {}),
        maximumLevel: b.opts.maxNativeZoom || b.opts.maxZoom, credit: b.opts.attribution.replace(/<[^>]+>/g, ""),
      }));
      if (b.grey) { layer.saturation = 0; layer.brightness = 1.06; layer.contrast = 0.9; }
    }
    // Sans relief : le sol est l'ellipsoïde, les altitudes sont celles du GPS.
    const top = Math.max(aMax + 500, 3000);
    for (const a of D.airspaces) {
      viewer3d.entities.add({
        name: `${a.name} (${a.lowerText} → ${a.upperText})`,
        polygon: {
          hierarchy: C.Cartesian3.fromDegreesArray(a.polygon.flatMap((p) => [p.lon, p.lat])),
          height: Math.max(0, a.lower), extrudedHeight: Math.min(a.upper, top + 2000),
          material: C.Color.RED.withAlpha(0.18), outline: true, outlineColor: C.Color.RED.withAlpha(0.6),
        },
      });
    }
    for (const z of D.zones) {
      const col = C.Color.fromCssColorString(color[z.role] || "#2563eb");
      if (z.line) {
        viewer3d.entities.add({ name: `Goal ${z.name}`, wall: { positions: C.Cartesian3.fromDegreesArray([z.line.a.lon, z.line.a.lat, z.line.b.lon, z.line.b.lat]), maximumHeights: [top, top], minimumHeights: [0, 0], material: col.withAlpha(0.3) } });
      } else {
        viewer3d.entities.add({
          name: `${z.index + 1}. ${ROLE[z.role] || z.role} ${z.name} (${m(z.radius)} m)`,
          position: C.Cartesian3.fromDegrees(z.lon, z.lat),
          ellipse: { semiMajorAxis: z.radius, semiMinorAxis: z.radius, height: 0, extrudedHeight: top, material: col.withAlpha(0.08), outline: true, outlineColor: col.withAlpha(0.8), numberOfVerticalLines: 24 },
        });
      }
    }
    lines3d = VS.map((v) => {
      const tr = v.track, pos = [];
      for (let i = tr.flightStart; i <= tr.flightEnd; i++) if (tr.alt[i] != null) pos.push(tr.lon[i], tr.lat[i], tr.alt[i]);
      return viewer3d.entities.add({ name: multi ? `${D.pilot.name} · ${vLabel(v)}` : D.pilot.name, polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(pos), width: 2, material: C.Color.fromCssColorString(v.color) } });
    });
    ghosts3d = VS.map((v) => viewer3d.entities.add({ position: C.Cartesian3.fromDegrees(0, 0, 0), show: false, point: { pixelSize: 9, color: C.Color.WHITE, outlineColor: C.Color.fromCssColorString(v.color), outlineWidth: 3 } }));
    cursor3d = viewer3d.entities.add({ position: C.Cartesian3.fromDegrees(TK.lon[idx], TK.lat[idx], TK.alt[idx] ?? 0), point: { pixelSize: 12, color: C.Color.YELLOW, outlineColor: C.Color.BLACK, outlineWidth: 2 } });
    viewer3d.flyTo(viewer3d.entities, { duration: 0 });
    draw3d();
  }
  // Version analysée en trait épais, autres versions affichées en trait fin ; points au plus près de la version analysée.
  function draw3d() {
    if (!viewer3d) return;
    const C = window.Cesium;
    lines3d.forEach((e, k) => { e.show = k === cur || shown.has(k); e.polyline.width = k === cur ? 3 : 1.5; });
    marks3d.forEach((e) => viewer3d.entities.remove(e));
    marks3d = V.approaches
      .filter((a) => !a.reached && a.closest)
      .map((a) => viewer3d.entities.add({ name: `${a.name} : ${edgeText(a.closest.distance)}`, position: C.Cartesian3.fromDegrees(a.closest.lon, a.closest.lat, a.closest.altitude ?? 0), point: { pixelSize: 10, color: C.Color.ORANGE, outlineColor: C.Color.WHITE, outlineWidth: 2 } }));
    update3d();
  }
  function update3d() {
    if (!cursor3d) return;
    const C = window.Cesium, t = TK.t[idx];
    cursor3d.position = C.Cartesian3.fromDegrees(TK.lon[idx], TK.lat[idx], TK.alt[idx] ?? 0);
    VS.forEach((v, k) => {
      const tr = v.track, g = ghosts3d[k];
      g.show = k !== cur && shown.has(k) && t >= tr.t[0] && t <= tr.t[tr.t.length - 1];
      if (!g.show) return;
      const j = indexIn(tr, t);
      g.position = C.Cartesian3.fromDegrees(tr.lon[j], tr.lat[j], tr.alt[j] ?? 0);
    });
  }
  root.querySelectorAll(".v-tabs button").forEach((b) =>
    b.addEventListener("click", async () => {
      root.querySelectorAll(".v-tabs button").forEach((x) => x.classList.toggle("on", x === b));
      const three = b.dataset.mode === "3d";
      document.getElementById("v-map").hidden = three;
      document.getElementById("v-3d").hidden = !three;
      if (three) {
        try { await open3d(); update3d(); }
        catch (e) { document.getElementById("v-3d").textContent = T("La vue 3D n'a pas pu se charger : {error}", { error: e.message }); }
      } else map.invalidateSize();
    }),
  );

  // ---- Lecture ------------------------------------------------------------------------------
  function setIndex(i, pan) {
    idx = Math.max(0, Math.min(N - 1, i));
    slider.value = String(idx);
    cursor.setLatLng(ll(idx));
    moveGhosts2d(TK.t[idx]);
    if (pan) map.panTo(ll(idx));
    renderNow();
    drawBaro();
    update3d();
  }
  slider.addEventListener("input", () => setIndex(Number(slider.value)));
  document.getElementById("v-prev").onclick = () => setIndex(idx - 1);
  document.getElementById("v-next").onclick = () => setIndex(idx + 1);
  let timer = null;
  const playBtn = document.getElementById("v-play");
  playBtn.onclick = () => {
    if (timer) { clearInterval(timer); timer = null; playBtn.textContent = "▶"; return; }
    playBtn.textContent = "❚❚";
    let last = performance.now();
    timer = setInterval(() => {
      const nowMs = performance.now();
      const target = TK.t[idx] + (nowMs - last) * Number(document.getElementById("v-speed").value);
      last = nowMs;
      const j = indexAt(target);
      if (j >= TK.flightEnd) { setIndex(TK.flightEnd); playBtn.click(); return; }
      setIndex(Math.max(j, idx + 1), false);
    }, 100);
  };
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowLeft") setIndex(idx - (e.shiftKey ? 30 : 1));
    if (e.key === "ArrowRight") setIndex(idx + (e.shiftKey ? 30 : 1));
    if (e.key === " ") { e.preventDefault(); playBtn.click(); }
  });

  // ---- Versions -------------------------------------------------------------------------------
  function summary(v) {
    const r = v.result;
    const res = r.madeGoal ? `Goal ${hhmmss(r.goalTime)}` : r.madeEss ? `ESS ${hhmmss(r.essTime)}` : `${km(r.flownDistance)} km`;
    const miss = v.approaches.find((a) => !a.reached && a.closest);
    const missTxt = miss ? T("{zone} manqué de {d} m", { zone: miss.role === "sss" ? ROLE.sss : `${ROLE[miss.role] || miss.role} ${esc(miss.name)}`, d: m(Math.abs(miss.closest.distance), 1) }) : "";
    const depth = v.infringements.length ? Math.max(...v.infringements.map((i) => i.depth)) : 0;
    return { res, start: r.startTime ? hhmmss(r.startTime) : T("aucun"), missTxt, air: depth ? T("{d} m dans {name}", { d: m(depth, 1), name: esc(v.infringements.find((i) => i.depth === depth).name) }) : "" };
  }
  const fmtDay = new Intl.DateTimeFormat(LOC, { timeZone: tz, day: "2-digit", month: "2-digit" });
  function renderVersions() {
    const tbl = document.getElementById("v-versions");
    if (!tbl) return;
    tbl.innerHTML = `<thead><tr><th></th><th>${T("Afficher")}</th><th>${T("Analyser")}</th><th>${T("Version")}</th><th>${T("Reçue")}</th><th>${T("Résultat")}</th><th>${T("Départ")}</th><th>${T("À vérifier")}</th></tr></thead><tbody>${VS.map((v, k) => {
      const s = summary(v);
      const remarks = [s.missTxt, s.air && `<span class="bad">${s.air}</span>`, v.note && `<span class="muted">${esc(v.note)}</span>`].filter(Boolean).join("<br>");
      return `<tr class="${k === cur ? "on" : ""}">
        <td><span class="v-sw" style="background:${v.color}"></span></td>
        <td><input type="checkbox" data-show="${k}" ${shown.has(k) || k === cur ? "checked" : ""} ${k === cur ? "disabled" : ""}></td>
        <td><input type="radio" name="v-cur" data-cur="${k}" ${k === cur ? "checked" : ""}></td>
        <td><b>${vLabel(v)}</b><br><span class="small muted">${esc(v.filename)}</span></td>
        <td class="small">${fmtDay.format(new Date(v.uploadedAt))} ${hhmmss(v.uploadedAt)}${v.uploadedBy ? `<br><span class="muted">${esc(v.uploadedBy)}</span>` : ""}</td>
        <td>${s.res}</td><td>${s.start}</td><td class="small">${remarks || "–"}</td></tr>`;
    }).join("")}</tbody>`;
  }
  function selectVersion(k) {
    const t = TK.t[idx];
    bind(k);
    slider.max = String(N - 1);
    renderVersions(); renderEvents(); drawTracks2d(); draw3d();
    // Même instant dans la nouvelle version, si elle le couvre.
    setIndex(t >= TK.t[0] && t <= TK.t[N - 1] ? indexAt(t) : TK.flightStart);
    const u = new URL(location.href); u.searchParams.set("v", V.sha256); history.replaceState(null, "", u);
  }
  const vt = document.getElementById("v-versions");
  if (vt) vt.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.cur != null) return selectVersion(Number(el.dataset.cur));
    if (el.dataset.show != null) {
      const k = Number(el.dataset.show);
      el.checked ? shown.add(k) : shown.delete(k);
      drawTracks2d(); draw3d(); setIndex(idx);
    }
  });
  renderVersions();
  renderEvents();

  // Ouverture : sur le premier passage manqué s'il y en a un, sinon au décollage.
  const miss = V.approaches.find((a) => !a.reached && a.closest);
  setIndex(miss ? indexAt(miss.closest.time) : TK.flightStart, !!miss);
  if (miss) map.setView(ll(idx), 14);
})();
