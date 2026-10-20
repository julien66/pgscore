// Page de la manche : suivi de l'envoi des traces et du calcul.
// Envoi : progression de l'envoi, puis du traitement sur le serveur.
// Calcul : lancé sans recharger la page ; l'avancement est relu chaque seconde et affiché étape par
// étape, puis seul le bloc « Calcul » est remplacé par le classement.
(function () {
  "use strict";
  const size = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} Ko` : `${(b / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`);
  for (const f of document.querySelectorAll("form.upload")) {
    const input = f.querySelector("input[type=file]");
    const status = document.createElement("div");
    status.className = "upl small";
    f.after(status);
    input.addEventListener("change", () => {
      const files = [...input.files];
      const total = files.reduce((n, x) => n + x.size, 0);
      const zips = files.filter((x) => /\.zip$/i.test(x.name) || x.type.includes("zip")).length;
      status.innerHTML = files.length
        ? `<span class="muted">${files.length} fichier${files.length > 1 ? "s" : ""}${zips ? ` dont ${zips} archive${zips > 1 ? "s" : ""}` : ""}, ${size(total)}</span>`
        : "";
    });
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const btn = f.querySelector("button");
      btn.disabled = true;
      const total = [...input.files].reduce((n, x) => n + x.size, 0);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", f.action);
      xhr.upload.onprogress = (e) => {
        const pct = e.lengthComputable ? Math.round((100 * e.loaded) / e.total) : 0;
        status.innerHTML = `<p><span class="spin"></span> Envoi des fichiers : ${pct} % <span class="muted">(${size(e.loaded)} sur ${size(e.total || total)})</span></p><div class="bar"><div style="width:${pct}%"></div></div>`;
      };
      xhr.upload.onload = () => {
        status.innerHTML = `<p><span class="spin"></span> Fichiers reçus. Lecture des archives, contrôle des fichiers IGC et enregistrement des traces…</p><div class="bar busy"><div></div></div>`;
      };
      xhr.onload = () => {
        // Succès : le serveur redirige vers la page de la manche avec le bilan de l'envoi.
        if (xhr.status < 400 && xhr.responseURL) return location.assign(xhr.responseURL);
        document.open(); document.write(xhr.responseText); document.close();
      };
      xhr.onerror = () => {
        btn.disabled = false;
        status.innerHTML = '<p class="err">L\'envoi a échoué (connexion interrompue). Réessayez.</p>';
      };
      xhr.send(new FormData(f));
    });
  }
  // Bloc replié ciblé par l'adresse (#decisions…) : on l'ouvre.
  const openHash = () => {
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (target && target.tagName === "DETAILS") target.open = true;
  };
  openHash();
  window.addEventListener("hashchange", openHash);

  const STEPS = [
    ["prepare", "Lecture de la manche, des paramètres et des espaces aériens"],
    ["control", "Contrôle des traces"],
    ["leading", "Leading et classement"],
    ["save", "Enregistrement des résultats"],
  ];
  const LABEL = { GOAL: "Goal", ESS: "ESS", DF: "Posé", MIND: "Distance min.", ERREUR: "Erreur" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const km = (m) => (m / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const dur = (s) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);
  let skew = 0, last = null, failures = 0;

  const card = document.getElementById("run-card");
  if (!card) return;
  let box = null, url = null, timer = null;
  const swap = (html) => {
    card.innerHTML = html;
    bind();
  };
  function bind() {
    const form = document.getElementById("run-form");
    if (form) form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const b = form.querySelector("button");
      const label = b.innerHTML;
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span> Démarrage du calcul…';
      try {
        const res = await fetch(form.action, { method: "POST", headers: { "x-requested-with": "fetch" }, credentials: "same-origin" });
        if (res.ok) return swap(await res.text());
        const err = await res.json().catch(() => ({}));
        b.disabled = false;
        b.innerHTML = label;
        card.insertAdjacentHTML("beforeend", `<div class="err">${esc(err.error || "Le calcul n'a pas pu démarrer.")}</div>`);
      } catch (e) {
        form.submit();
      }
    });
    box = document.getElementById("run-live");
    if (box && !timer) {
      url = box.dataset.url;
      poll();
    }
  }
  function render(r) {
    const now = Date.now() + skew;
    const elapsed = (now - r.startedAt) / 1000;
    const cur = STEPS.findIndex(([k]) => k === r.step);
    const d = r.detail || {};
    const pct = r.total ? Math.round((100 * r.done) / r.total) : 0;
    // Temps restant estimé d'après le rythme du contrôle (le reste du calcul est court).
    let eta = "";
    if (r.step === "control" && r.done >= 3 && r.done < r.total) {
      const rate = elapsed / r.done;
      eta = ` · encore environ ${dur(rate * (r.total - r.done))}`;
    }
    const steps = STEPS.map(([k, label], i) => {
      const state = cur < 0 ? "todo" : i < cur ? "done" : i === cur ? "now" : "todo";
      const icon = state === "done" ? "✓" : state === "now" ? '<span class="spin"></span>' : "○";
      let extra = "";
      if (k === "prepare" && i < cur && d.airspaces != null) extra = ` <span class="muted">· ${d.airspaces} espace${d.airspaces > 1 ? "s" : ""} aérien${d.airspaces > 1 ? "s" : ""}</span>`;
      if (k === "control" && i <= cur) extra = ` <span class="muted">· ${r.done} / ${r.total}</span>`;
      return `<li class="${state}"><span class="ic">${icon}</span>${label}${extra}</li>`;
    }).join("");
    const counts = d.counts
      ? Object.entries(LABEL).filter(([k]) => d.counts[k]).map(([k, l]) => `<span class="chip s-${k}">${l} ${d.counts[k]}</span>`).join("") +
        (d.airspaceInfringements ? `<span class="chip s-ERREUR">Espace aérien ${d.airspaceInfringements}</span>` : "")
      : "";
    const recent = (d.recent || []).map((p) =>
      `<li><span class="chip s-${p.status}">${LABEL[p.status] || p.status}</span> ${esc(p.name)} <span class="muted">${p.status === "ERREUR" ? "" : `${km(p.distance)} km`}${p.note ? ` · ${esc(p.note)}` : ""}</span></li>`).join("");
    box.innerHTML = `
      <ol class="steps">${steps}</ol>
      <div class="bar"><div style="width:${r.step === "control" ? pct : cur > 1 ? 100 : 0}%"></div></div>
      <p class="small muted">${d.pilot ? `En cours : <b>${esc(d.pilot)}</b> · ` : ""}${dur(elapsed)} écoulées${eta}</p>
      ${counts ? `<div class="chips">${counts}</div>` : ""}
      ${recent ? `<p class="small muted mt">Dernières traces contrôlées</p><ul class="recent">${recent}</ul>` : ""}`;
  }

  async function poll() {
    try {
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      const r = await res.json();
      failures = 0;
      if (r.now) skew = r.now - Date.now();
      if (r.status === "done" || r.status === "error") {
        timer = null;
        last = null;
        const res = await fetch(url.replace(/run\.json$/, "run-card"), { cache: "no-store", credentials: "same-origin" });
        return res.ok ? swap(await res.text()) : location.reload();
      }
      if (r.status === "queued" || r.status === "running") { last = r; render(r); }
    } catch (e) {
      // Serveur momentanément injoignable (redémarrage, réseau) : on réessaie, en le signalant.
      if (++failures >= 5) box.insertAdjacentHTML("beforeend", '<p class="small err">Le serveur ne répond pas, nouvel essai…</p>');
    }
    timer = setTimeout(poll, 1000);
  }
  // Le temps écoulé avance entre deux relectures.
  setInterval(() => last && box && box.isConnected && render(last), 1000);
  bind();
})();
