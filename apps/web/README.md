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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | connexion Google | aucune |
| `DEV_LOGIN` | `1` : connexion de test sans fournisseur, **jamais en production** | désactivée |

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

Chaque compétition n'est visible que par son créateur pour l'instant.
