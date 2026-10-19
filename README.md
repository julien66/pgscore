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
pnpm test
cd apps/web && DEV_LOGIN=1 pnpm dev   # http://localhost:3000
```

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
- [ ] Classement général (FTV)
- [x] Décisions de l'organisateur : bonus, pénalités, goal accordé, ABS, DNF, décollé sans trace
- [ ] Plusieurs organisateurs par compétition, résultats publics
