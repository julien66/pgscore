// Page de la compétition : la case « officielle » s'enregistre seule et met à jour le classement général sans recharger.
(() => {
  for (const box of document.querySelectorAll("form.official input[name=official]")) {
    box.addEventListener("change", async () => {
      const form = box.form;
      const body = new FormData(form);
      if (!box.checked) body.set("official", "0");
      box.disabled = true;
      try {
        const r = await fetch(form.action, { method: "POST", body, headers: { "x-requested-with": "fetch" } });
        if (!r.ok) throw new Error(String(r.status));
        const html = await (await fetch(location.pathname, { cache: "no-store" })).text();
        const fresh = new DOMParser().parseFromString(html, "text/html").getElementById("standings");
        const cur = document.getElementById("standings");
        if (fresh && cur) cur.innerHTML = fresh.innerHTML;
      } catch {
        box.checked = !box.checked;
        alert("Impossible d'enregistrer : réessayez.");
      } finally {
        box.disabled = false;
      }
    });
  }
})();
