// Toutes les pages : confirmation avant les actions destructives (data-confirm sur un formulaire ou un
// bouton), sans gestionnaire en ligne, pour que la politique de sécurité (CSP) puisse les interdire.
(function () {
  "use strict";
  document.addEventListener("submit", (ev) => {
    const msg = /** @type {HTMLElement} */ (ev.target).dataset.confirm;
    if (msg && !confirm(msg)) ev.preventDefault();
  }, true);
  document.addEventListener("click", (ev) => {
    const b = /** @type {HTMLButtonElement | null} */ (/** @type {Element} */ (ev.target).closest("button[data-confirm]"));
    if (b && !confirm(b.dataset.confirm)) ev.preventDefault();
  }, true);
})();

// Bloc affiché seulement quand un fichier est choisi dans le champ nommé (data-if-file="airspace").
(function () {
  "use strict";
  const sync = () => {
    for (const el of document.querySelectorAll("[data-if-file]")) {
      const form = el.closest("form");
      const input = form && form.querySelector(`input[type=file][name="${el.getAttribute("data-if-file")}"]`);
      if (input instanceof HTMLInputElement) /** @type {HTMLElement} */ (el).hidden = !(input.files && input.files.length);
    }
  };
  document.addEventListener("change", sync);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync);
  else sync();
})();
