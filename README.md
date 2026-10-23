# pgscore

Application web de contrôle et de scoring des compétitions de parapente cross-country, conforme au FAI Sporting Code Section 7F (édition 2026) et extensible par profils de règles.

## Organisation

| Dossier | Rôle |
| --- | --- |
| `packages/engine` | Moteur de contrôle pur (sans base ni interface) : formats (.xctsk, IGC), géodésie WGS84, validation des manches |
| `apps/web` | Interface web : connexion Google, compétitions, manches, traces, calcul (voir son README) |

## Démarrer

```sh
pnpm install
pnpm --filter @pgscore/web exec playwright install chromium   # navigateur des tests de pages
pnpm test
cd apps/web && DEV_LOGIN=1 pnpm dev   # http://localhost:3000
```

`apps/web/test/browser.test.ts` ouvre les pages dans Chromium (Playwright) : calcul suivi en direct, visionneuse, aucune erreur JavaScript ni violation de la politique de sécurité. `pnpm typecheck` vérifie aussi les scripts du navigateur (`apps/web/src/static/*.js`, `tsconfig.static.json`).

Les tests de calcul PWCA (Gemona, Feltre, Baixo Guandu, Sopot) et les tests complets du French Open - Trophées des Cimes 2026 (FS) et de la German Open 2026 (copie de civlcomps), ZIP sur la branche `test-data`, ont besoin des traces des manches, publiques sur scoring.pwca.org. Sans elles, ils sont sautés. En CI, ils ne tournent que si le changement touche au calcul (moteur, import et calcul côté appli, données de test). Pour les lancer :

```sh
eval "$(scripts/fetch-test-tracks.sh --env)"   # télécharge dans .test-data/ et exporte les variables
pnpm test
```

À chaque push et chaque pull request, GitHub Actions (`.github/workflows/ci.yml`) vérifie les types et lance tous les tests, traces comprises. Render ne déploie `main` que si cette vérification passe.

## État

Étape 1, contrôle de vol, en cours :

- [x] Lecture des manches XCTrack (.xctsk v1 et QR code v2)
- [x] Lecture et réécriture des fichiers IGC
- [x] Distances sur l'ellipsoïde WGS84 (GeographicLib)
- [x] Route optimisée (projection LTM + PathFinder, S7F 7.1)
- [x] Validation des balises, du départ, de l'ESS et du goal, distance parcourue (S7F 9.2, 9.3)
- [x] Paramètres de compétition et distance minimale (S7F 5, 9.3)
- [x] Manches arrêtées : score-back, fenêtre de vol, bonus d'altitude (S7F 13.4)
- [x] Espaces aériens OpenAir : lecture, infractions, pénalités PWCA
- [ ] Collecte PureTrack et reconstruction IGC

Interface, début :

- [x] Connexion Google (OpenID Connect)
- [x] Compétition : paramètres, règlement, espace aérien
- [x] Manche depuis un QR code (image ou texte) ou un fichier .xctsk
- [x] Envoi des traces (IGC ou zip) et calcul lancé à la main, export CSV
- [x] Points GAP de la manche : validités, répartition, points distance/temps/leading, pénalités, manches arrêtées (S7F 10 à 13), formule S7F 2026 ou PWCA 2026 (vérifiée sur 7 manches PWCA, ~480 pilotes au dixième de point)
- [x] Classement général (FTV, S7F 15–16) : manches marquées officielles, export CSV
- [x] Pilotes inscrits : import FSDB (FS) ou CSV, tableau modifiable, export CSV
- [x] Import d'une compétition depuis civlcomps.org (adresse de la page de résultats) : manches, pilotes, pénalités, absents et traces, points recalculés (vérifié sur les Trophées des Cimes 2026 : 5 manches, 96 pilotes à 0,3 point près)
- [x] Classements extraits du général : féminin d'office, autres par règle (classe de voile, PTV…) avec ajouts et retraits à la main
- [ ] Classement des nations
- [x] Décisions de l'organisateur : bonus, pénalités, goal accordé, ABS, DNF, décollé sans trace
- [x] Service externe (bots Telegram) : retours des pilotes et incidents reçus par API, rattachés aux manches ([documentation](docs/api-service-externe.md))
- [ ] Plusieurs organisateurs par compétition, résultats publics

## Licence

pgscore est un logiciel libre, distribué sous la licence GNU Affero General Public License, version 3 ou ultérieure (AGPL-3.0-or-later) : voir [LICENSE](LICENSE). Toute version modifiée mise à disposition sur un réseau doit offrir son code source à ses utilisateurs.

Copyright © 2026 Julien Garcia et les contributeurs de pgscore.
