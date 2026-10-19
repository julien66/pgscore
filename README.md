# pgscore

Application web de contrôle et de scoring des compétitions de parapente cross-country, conforme au FAI Sporting Code Section 7F (édition 2026) et extensible par profils de règles.

## Organisation

| Dossier | Rôle |
| --- | --- |
| `packages/engine` | Moteur de contrôle pur (sans base ni interface) : formats (.xctsk, IGC), géodésie WGS84, validation des manches |
| `apps/` | Application web et API (à venir) |

## Démarrer

```sh
pnpm install
pnpm test
```

## État

Étape 1, contrôle de vol, en cours :

- [x] Lecture des manches XCTrack (.xctsk v1 et QR code v2)
- [x] Lecture et réécriture des fichiers IGC
- [x] Distances sur l'ellipsoïde WGS84 (GeographicLib)
- [x] Route optimisée (projection LTM + PathFinder, S7F 7.1)
- [x] Validation des balises, du départ, de l'ESS et du goal, distance parcourue (S7F 9.2, 9.3)
- [x] Paramètres de compétition et distance minimale (S7F 5, 9.3)
- [x] Espaces aériens OpenAir : lecture, infractions, pénalités PWCA
- [ ] Collecte PureTrack et reconstruction IGC
