// Page de la compétition : la case « officielle » s'enregistre seule et met à jour le classement général sans recharger.
(() => {
  // Bloc replié ciblé par l'adresse (#pilots…) : on l'ouvre.
  const openHash = () => {
    const el = location.hash && document.getElementById(location.hash.slice(1));
    if (el && el.tagName === "DETAILS") el.open = true;
  };
  openHash();
  window.addEventListener("hashchange", openHash);

  // Détail sportif des classements (manches, temps, points) : replié par défaut, choix gardé par le navigateur.
  const SPORT = "pgscore.sport";
  let sportOpen = false;
  try {
    sportOpen = localStorage.getItem(SPORT) === "1";
  } catch {}
  const applySport = () => {
    for (const tb of document.querySelectorAll("table.rk")) tb.classList.toggle("sport-hidden", !sportOpen);
    document.documentElement.classList.toggle("sport-open", sportOpen);
  };
  applySport();
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest(".sp-toggle");
    if (!b) return;
    sportOpen = !sportOpen;
    try {
      localStorage.setItem(SPORT, sportOpen ? "1" : "0");
    } catch {}
    applySport();
  });

  // Impression d'un classement : seul son bloc reste, détail sportif déplié, tableau réduit à la largeur d'une page A4 portrait.
  function printBoard(box) {
    const hidden = [];
    for (let el = box; el && el !== document.body; el = el.parentElement) {
      for (const sib of el.parentElement.children) {
        if (sib === el || sib.tagName === "SCRIPT" || sib.classList.contains("no-print")) continue;
        sib.classList.add("no-print");
        hidden.push(sib);
      }
    }
    const title = document.title;
    const page = title.replace(/ · pgscore$/, "");
    // Classement choisi, puis manche et vue (« M2 · Cumul après M2 ») s'il y en a une.
    const which = [...box.querySelectorAll("nav.tabs a.on, nav.mtabs a.on:not(:first-child)")]
      .map((a) => a.textContent.trim())
      .filter(Boolean)
      .join(" · ");
    const head = document.createElement("div");
    head.className = "print-head";
    const strong = document.createElement("strong");
    strong.textContent = page;
    const span = document.createElement("span");
    span.textContent = [which, new Date().toLocaleDateString(document.documentElement.lang || undefined)].filter(Boolean).join(" · ");
    head.append(strong, span);
    box.prepend(head);
    box.classList.add("print-me");
    document.body.classList.add("printing");
    document.title = [page, which].filter(Boolean).join(" - ");
    const tables = [...box.querySelectorAll("table.rk")];
    for (const tb of tables) {
      tb.style.zoom = "";
      const w = tb.scrollWidth;
      if (w > box.clientWidth) tb.style.zoom = String(box.clientWidth / w);
    }
    const undo = () => {
      for (const el of hidden) el.classList.remove("no-print");
      for (const tb of tables) tb.style.zoom = "";
      head.remove();
      box.classList.remove("print-me");
      document.body.classList.remove("printing");
      document.title = title;
    };
    window.addEventListener("afterprint", undo, { once: true });
    window.print();
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest(".print-rk");
    if (b) printBoard(b.closest("[data-swap]") || b.closest(".card"));
  });

  // Onglets de classement (général, féminin…) et « voir tous » : seul le bloc [data-swap] est remplacé.
  async function loadBoard(url, id) {
    const cur = document.getElementById(id || "standings");
    if (!cur) return;
    cur.classList.add("loading");
    try {
      const html = await (await fetch(url.split("#")[0], { cache: "no-store", credentials: "same-origin" })).text();
      const fresh = new DOMParser().parseFromString(html, "text/html").getElementById(cur.id);
      if (fresh) cur.innerHTML = fresh.innerHTML;
      applySport();
    } finally {
      cur.classList.remove("loading");
    }
  }
  document.addEventListener("click", async (ev) => {
    const a = ev.target.closest && ev.target.closest("[data-swap] a.swap");
    if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    try {
      await loadBoard(a.href, a.closest("[data-swap]").id);
      history.pushState({ board: true }, "", a.href.split("#")[0]);
    } catch {
      location.assign(a.href);
    }
  });
  window.addEventListener("popstate", () => {
    for (const el of document.querySelectorAll("[data-swap]")) loadBoard(location.href, el.id).catch(() => location.reload());
  });
  for (const box of document.querySelectorAll("form.official input[name=official]")) {
    box.addEventListener("change", async () => {
      const form = box.form;
      const body = new FormData(form);
      if (!box.checked) body.set("official", "0");
      box.disabled = true;
      try {
        const r = await fetch(form.action, { method: "POST", body, headers: { "x-requested-with": "fetch" } });
        if (!r.ok) throw new Error(String(r.status));
        await loadBoard(location.pathname + location.search);
      } catch {
        box.checked = !box.checked;
        alert(T("Impossible d'enregistrer : réessayez."));
      } finally {
        box.disabled = false;
      }
    });
  }
})();
