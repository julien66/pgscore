# pgscore web

Première interface : connexion, compétitions (paramètres et espace aérien), manches (QR code ou
.xctsk), envoi des traces IGC et calcul lancé à la main.

## Lancer

```sh
pnpm install
cd apps/web
DEV_LOGIN=1 pnpm dev      # http://localhost:3000, connexion de test sans Google
```

Variables :

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | port HTTP | 3000 |
| `BASE_URL` | adresse publique, sans « / » final | `http://localhost:PORT` |
| `DATABASE_PATH` | fichier SQLite | `data/pgscore.db` |
| `TRACKS_DIR` | dossier des fichiers IGC | `tracks` à côté de la base |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | connexion Google | aucune |
| `DEV_LOGIN` | `1` : connexion de test sans fournisseur, **jamais en production** | désactivée |

Les fichiers IGC sont gardés tels que reçus, hors de la base, dans `TRACKS_DIR`, rangés sous leur
empreinte SHA-256 (`tracks/ab/abcdef….igc`). Un fichier n'est jamais modifié ni écrasé ; une trace
remplacée ou supprimée dans une manche reste dans le dossier. La base ne garde que le nom du fichier,
sa taille et son empreinte. Sauvegarder = copier la base et ce dossier.

Node 22.5 ou plus récent (base SQLite intégrée à Node).

## Connexion Google

1. Dans la console Google Cloud, « API et services » › « Identifiants » › « Créer des identifiants »
   › « ID client OAuth », type « Application Web ».
2. URI de redirection autorisé : `BASE_URL/auth/callback` (par exemple
   `http://localhost:3000/auth/callback` en local).
3. Reporter l'ID client et le code secret dans `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`.

La connexion suit OpenID Connect (code d'autorisation avec PKCE). Aucun mot de passe n'est stocké ;
la base garde l'identifiant du compte Google, l'e-mail et le nom. D'autres fournisseurs OpenID
pourront s'ajouter de la même façon.

## Ce que fait le calcul

Pour chaque trace : contrôle du vol (départ, balises, ESS, goal, distance), manche arrêtée,
distance minimale, espaces aériens et pénalité, puis coefficient de leading sur l'ensemble des
pilotes. Le classement est provisoire : les points GAP ne sont pas encore calculés.

Le calcul tourne dans le serveur, un pilote après l'autre ; la page de la manche affiche
l'avancement. Compter environ une seconde par trace.

## Vue d'une trace

Dans les résultats, le nom du pilote ouvre sa trace : carte 2D (fond OpenStreetMap, il faut
Internet) et vue 3D (Cesium, sans relief : altitudes sur l'ellipsoïde). Lecture, avance pas à pas
(flèches, espace), barogramme avec les planchers et plafonds des espaces aériens traversés, et la
liste du contrôle : balises validées, zone manquée avec la distance au bord du cylindre au plus
près (calculée sur l'ellipsoïde WGS84, comme le contrôle), infractions d'espace aérien. La colonne
« Remarque » des résultats signale une zone manquée de moins de 500 m.

Chaque compétition n'est visible que par son créateur pour l'instant.
