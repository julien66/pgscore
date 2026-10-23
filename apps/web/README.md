# pgscore web

Interface web : connexion, compétitions (paramètres, espace aérien, pilotes, classements), manches
(QR code ou .xctsk), envoi des traces IGC, calcul, résultats et vue des traces. Import et export de
compétitions (archive pgscore, FSDB, civlcomps.org).

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
| `UPLOAD_DIR` | envois en cours (traces, archives), écrits sur disque puis effacés | `uploads` à côté de la base |
| `SCORE_WORKER_HEAP_MB` | mémoire du calcul d'une manche (Mo) | 160 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | connexion Google | aucune |
| `DEV_LOGIN` | `1` : connexion de test sans fournisseur, **jamais en production** | désactivée |
| `ADMIN_EMAILS` | e-mails des administrateurs, séparés par des virgules : ils modifient toutes les compétitions (les autres utilisateurs voient tout mais ne modifient que les leurs) | aucun |

Les fichiers IGC sont gardés tels que reçus, hors de la base, dans `TRACKS_DIR`, rangés sous leur
empreinte SHA-256 (`tracks/ab/abcdef….igc.gz`, compressés : environ 0,12 Mo par trace). Un fichier n'est jamais modifié ni écrasé ; une trace
remplacée ou supprimée dans une manche reste dans le dossier. La base ne garde que le nom du fichier,
sa taille et son empreinte. Sauvegarder = copier la base et ce dossier.

Remplacer une trace : renvoyer un fichier qui porte le numéro du pilote, ou « Remplacer » sur la
ligne du pilote (n'importe quel nom de fichier, raison facultative). L'ancienne version reste
téléchargeable dans « Anciennes versions », avec qui l'a remplacée et quand ; une trace retirée y
passe aussi. La page signale quand des traces ont changé depuis le dernier calcul.

Quand un pilote a plusieurs versions de trace, sa page les liste avec, pour chacune, le résultat,
l'heure de départ et ce qui est à vérifier (zone manquée, espace aérien). On peut superposer les
versions sur la carte, le barogramme et la vue 3D, et choisir celle dont le contrôle est détaillé.

Node 22.5 ou plus récent (base SQLite intégrée à Node).

## Hébergement sur Render

Le fichier `render.yaml` à la racine décrit le service (Blueprint) : dans Render, « New » ›
« Blueprint », choisir le dépôt, puis renseigner `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` et, si
l'appli a un nom de domaine, `BASE_URL` (sinon l'adresse en onrender.com est prise).

- La base et les traces sont sur un disque Render monté en `/var/data`. Sans disque, tout serait
  perdu à chaque redéploiement : le plan gratuit ne convient donc pas (plan Starter au minimum).
- Avec un disque, Render ne fait tourner qu'une instance et coupe le service quelques secondes à
  chaque déploiement. Un calcul en cours pendant un déploiement est à relancer.
- Render sauvegarde le disque chaque jour (instantanés gardés 7 jours).

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
pilotes, et enfin les points GAP : validité de la manche, points disponibles, points distance,
temps et leading de chaque pilote, pénalités. La formule se choisit dans les réglages de la
compétition : CIVL GAP 2026 (comme FS) ou PWCA 2026 (comme SVL : coefficients arrondis, LTR 26,3158 %,
meilleur temps parmi tous les pilotes à l'ESS). Le leading se calcule d'une seule façon, celle de FS et
de SVL (sans le facteur de distance restante du texte S7F), vérifiée à 0,1 point près sur Baixo Guandu
2026 (PWCA) et la manche 1 du French Open 2026 (FS).

Réglages de la manche utiles aux points : Leading Time Ratio (26 % par défaut en S7F), nombre de
pilotes présents pour la validité de décollage (par défaut, ceux qui ont volé), fin des vols pour le
leading (dernière arrivée à l'ESS par défaut, ou dernier pilote en vol), et heure de fin de manche si
l'organisation en fixe une plus tardive. Dans « Règles anciennes », l'orientation d'un goal en ligne :
perpendiculaire à la route optimisée (S7F 2026, PWCA, par défaut) ou au centre de la balise précédente
(S7F 2024).

Le calcul tourne dans un worker_thread (`src/score-worker.ts`), un pilote après l'autre, pour que les
pages restent servies ; la page de la manche affiche l'avancement trace par trace. Compter un quart de
seconde à une seconde par trace. Seuls le dernier calcul de chaque manche et son dernier calcul terminé
sont gardés en base.

## Vue d'une trace

Dans les résultats, le nom du pilote ouvre sa trace : carte 2D (fond OpenStreetMap, il faut
Internet) et vue 3D (Cesium, sans relief : altitudes sur l'ellipsoïde). Lecture, avance pas à pas
(flèches, espace), barogramme avec les planchers et plafonds des espaces aériens traversés, et la
liste du contrôle : balises validées, zone manquée avec la distance au bord du cylindre au plus
près (calculée sur l'ellipsoïde WGS84, comme le contrôle), infractions d'espace aérien. La colonne
« Remarque » des résultats signale une zone manquée de moins de 500 m.

## Service externe : retours des pilotes et incidents

Un service externe global, lié aux bots Telegram des compétitions, envoie des données sur les manches :
satisfaction des pilotes, accidents et incidents. Il ne connaît ni nos compétitions ni nos manches :
chaque élément donne le nom de l'événement et une date.

- **Clé d'envoi** `pgsi_…`, créée par un administrateur (`ADMIN_EMAILS`) dans « Mon compte » › « Gérer
  le service externe » (`/admin/ingest`), montrée une seule fois, empreinte seule en base. Elle ne sert
  qu'à l'envoi : ni lecture des données reçues, ni modification des compétitions.
- **Envoi** : `POST /api/ingest`, corps JSON (objet, liste ou `{"items": [...]}`, 10 000 éléments et
  5 Mo au plus). Champs lus : `event` (ou `event_name`, `competition`), `date` (jour ou horodatage
  ISO ; ou `day`, `time`, `datetime`, `timestamp`), `type` et `id`. Tout l'élément est gardé tel quel
  (table `task_reports`) ; un même `type` + `id` renvoyé remplace l'élément. `GET /api/ingest` liste
  les compétitions connues avec leurs dates et manches. Clé dans `Authorization: Bearer` ou `X-Api-Key`.
- **Appels bruts** : chaque appel authentifié est gardé tel que reçu (table `ingest_requests`, 200
  derniers), même illisible ou d'une autre forme (réponse 202) : l'administrateur le voit et le
  télécharge sur `/admin/ingest`, de quoi caler le traitement sur le format réel du service.
- **Rattachement** : compétitions dont les dates (ou une manche) couvrent le jour, puis la plus proche
  par le nom (mots communs, sans accents ni casse, sans ex æquo) ; puis la manche de ce jour s'il n'y en
  a qu'une. Sans date, il faut les trois quarts des mots. Un élément sans manche attend : il est
  rattaché de nouveau à chaque création de manche ou import, et l'administrateur peut le rattacher à
  la main (ce choix est gardé quand l'élément revient).

```sh
curl -H "Authorization: Bearer pgsi_…" -H "Content-Type: application/json" BASE_URL/api/ingest \
     -d '[{"type":"satisfaction","id":"tg-8812","event":"PWC Gemona 2026","date":"2026-07-28","score":4}]'
```

Pour l'instant, l'organisateur voit le JSON reçu dans l'onglet « Éditer » de la manche ; le traitement
(satisfaction, liste des incidents sur la page publique) viendra avec le format définitif du service.

## Limites et sécurité

- Taille des envois, vérifiée sur les octets reçus : 200 Mo pour un envoi de traces, 1 Go pour l'import
  d'une compétition, 20 Mo pour tout autre formulaire. Un envoi est lu en mémoire : sur une petite
  instance, préférer plusieurs envois de traces à un seul très gros ZIP.
- Les formulaires refusent un POST venant d'une autre origine.
- En-tête Content-Security-Policy : scripts et styles servis par l'appli seulement (aucun script en
  ligne), fonds de carte autorisés en images, pas d'affichage dans le cadre d'un autre site. La page
  d'une trace autorise en plus ce dont Cesium a besoin pour la vue 3D (WebAssembly, code généré,
  workers en `blob:`).
- Tout utilisateur connecté voit toutes les compétitions ; seuls leur créateur et les administrateurs
  (`ADMIN_EMAILS`) les modifient.

## Organisation du code

- `src/app.tsx` : middlewares (langue, origine, taille des envois, en-têtes, accès) et assemblage des
  routes, rangées par domaine dans `src/routes/` (`auth`, `home`, `api`, `competitions`, `tasks`).
- `src/pages/` : pages en JSX (Hono), une par domaine, et `layout.tsx` (CSS, en-tête, icônes).
- `src/repo.ts` : requêtes SQL reprises à plusieurs endroits ; `src/db.ts` : schéma et migrations.
- `src/reports.ts`, `src/routes/ingest.tsx` et `src/pages/ingest.tsx` : service externe (clés d'envoi, données reçues, rattachement aux manches).
- `src/runner.ts` et `src/score-worker.ts` : calcul d'une manche ; `src/standings.ts` : classements.
- `src/text.ts` : CSV, entités XML/HTML ; `src/static/` : scripts du navigateur.
- Le calcul lui-même est dans `packages/engine`.
