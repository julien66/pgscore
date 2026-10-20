// Page de la compétition : la case « officielle » s'enregistre seule et met à jour le classement général sans recharger.
(() => {
  // Bloc replié ciblé par l'adresse (#pilots…) : on l'ouvre.
  const openHash = () => {
    const el = location.hash && document.getElementById(location.hash.slice(1));
    if (el && el.tagName === "DETAILS") el.open = true;
  };
  openHash();
  window.addEventListener("hashchange", openHash);

  // Onglets de classement (général, féminin…) et « voir tous » : seul le bloc [data-swap] est remplacé.
  async function loadBoard(url, id) {
    const cur = document.getElementById(id || "standings");
    if (!cur) return;
    cur.classList.add("loading");
    try {
      const html = await (await fetch(url.split("#")[0], { cache: "no-store", credentials: "same-origin" })).text();
      const fresh = new DOMParser().parseFromString(html, "text/html").getElementById(cur.id);
      if (fresh) cur.innerHTML = fresh.innerHTML;
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
