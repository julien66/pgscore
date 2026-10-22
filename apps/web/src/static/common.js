// Toutes les pages : confirmation avant les actions destructives (data-confirm sur un formulaire ou un
// bouton), sans gestionnaire en ligne, pour que la politique de sécurité (CSP) puisse les interdire.
(function () {
  "use strict";
  document.addEventListener("submit", (ev) => {
    const msg = ev.target.dataset && ev.target.dataset.confirm;
    if (msg && !confirm(msg)) ev.preventDefault();
  }, true);
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("button[data-confirm]");
    if (b && !confirm(b.dataset.confirm)) ev.preventDefault();
  }, true);
})();
