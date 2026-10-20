// Page de la compétition : avancement du calcul des manches lancé après un import.
// L'état est relu chaque seconde ; quand tout est calculé, la page se recharge avec les résultats.
(function () {
  "use strict";
  const box = document.getElementById("comp-runs");
  if (!box) return;
  const STEP = {
    prepare: T("préparation"),
    control: T("contrôle des traces"),
    leading: T("leading et classement"),
    save: T("enregistrement"),
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const row = (r) => {
    let state, pct = 0, busy = false;
    if (r.status === "queued") state = T("en attente");
    else if (r.status === "running") {
      pct = r.total ? Math.round((100 * r.done) / r.total) : 0;
      busy = r.step !== "control";
      state = r.step === "control" ? T("contrôle des traces : {done} sur {total}", { done: r.done, total: r.total }) : STEP[r.step] || T("calcul en cours");
    } else if (r.status === "done") (state = T("calculée")), (pct = 100);
    else state = T("erreur : {error}", { error: r.error || "" });
    const icon = r.status === "running" ? '<span class="spin"></span> ' : r.status === "done" ? "✓ " : r.status === "error" ? "⚠ " : "";
    return `<li><div class="row" style="justify-content:space-between"><span>${icon}<strong>${esc(T("Manche {n}", { n: r.number }))}</strong></span><span class="small muted">${esc(state)}</span></div><div class="bar${busy ? " busy" : ""}"><div style="width:${busy ? 30 : pct}%"></div></div></li>`;
  };
  let failures = 0;
  const poll = async () => {
    try {
      const res = await fetch(box.dataset.url, { headers: { accept: "application/json" } });
      const runs = await res.json();
      failures = 0;
      const active = runs.filter((r) => r.status === "queued" || r.status === "running");
      const done = runs.filter((r) => r.status === "done").length;
      box.querySelector(".runs-head").textContent = active.length
        ? T("Calcul des manches : {done} sur {total}. Vous pouvez rester sur cette page, les résultats s'afficheront à la fin.", { done, total: runs.length })
        : T("Calcul terminé, affichage des résultats…");
      box.querySelector("ul").innerHTML = runs.map(row).join("");
      if (!active.length) return setTimeout(() => location.reload(), 800);
    } catch {
      if (++failures > 30) return;
    }
    setTimeout(poll, 1000);
  };
  poll();
})();
