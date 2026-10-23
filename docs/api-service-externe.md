# API du service externe : retours des pilotes et incidents

Le service externe envoie à pgscore les retours des pilotes (satisfaction) et les rapports d'accidents
et d'incidents, par un seul appel HTTPS en JSON. Il n'a pas besoin de connaître les compétitions ni les
manches de pgscore : chaque élément donne le nom de l'événement et une date, et pgscore le rattache
lui-même à la bonne compétition et à la bonne manche.

Chaque appel est gardé tel que reçu, même si son contenu n'a pas pu être lu. Le format détaillé des
éléments sera fixé à partir des premiers envois réels du service.

Dans ce document, `BASE_URL` désigne l'adresse publique de pgscore (par exemple
`https://pgscore-xxxx.onrender.com`). La même documentation, en quatre langues, est servie par
l'application sur `BASE_URL/api#ingest`. Le code est dans `apps/web/src/reports.ts`,
`apps/web/src/routes/ingest.tsx` et `apps/web/src/pages/ingest.tsx`.

## Authentification

Chaque appel porte une clé d'envoi qui commence par `pgsi_`. Elle est fournie par un administrateur de
pgscore (`ADMIN_EMAILS`), qui la crée dans « Mon compte » › « Gérer le service externe »
(`BASE_URL/admin/ingest`).

- La clé s'envoie dans l'en-tête `Authorization: Bearer pgsi_…`, ou à défaut dans `X-Api-Key: pgsi_…`.
- Elle sert uniquement à envoyer des données : elle ne permet ni de relire ce qui a été envoyé, ni de
  modifier une compétition. Une clé d'API personnelle (`pgs_…`) est refusée sur ces adresses.
- Elle n'est affichée qu'une fois, à sa création ; pgscore n'en garde que l'empreinte SHA-256. Une clé
  perdue ou qui a pu fuiter est supprimée et remplacée par une nouvelle.
- Les appels se font en HTTPS uniquement.

## Adresses

| Méthode | Adresse | Rôle |
| --- | --- | --- |
| `POST` (ou `PUT`) | `BASE_URL/api/ingest` | Envoyer des retours et des incidents. Toute adresse sous `/api/ingest/` est aussi acceptée. |
| `GET` | `BASE_URL/api/ingest` | Vérifier la clé et lister les compétitions connues de pgscore, avec leurs dates et leurs manches. |

L'envoi accepte un corps de 5 Mo au plus, de préférence avec `Content-Type: application/json`.

## Format de l'envoi

Le corps est un objet JSON, une liste d'objets, ou un objet `{"items": [...]}`, avec au plus 10 000
éléments. Chaque objet est un élément : une réponse de pilote, un rapport d'incident, etc. pgscore lit
quelques champs et garde tout le reste tel quel.

| Champ | Noms acceptés | Contenu | Utilité |
| --- | --- | --- | --- |
| Événement | `event`, `event_name`, `competition`, `competition_name` | Nom de la compétition, tel que le service le connaît | Retrouver la compétition |
| Date | `date`, `day`, `time`, `datetime`, `timestamp` | Jour `AAAA-MM-JJ` ou horodatage ISO 8601 | Retrouver la compétition et la manche du jour |
| Type | `type` | Texte libre, par exemple `satisfaction` ou `incident` | Classer les éléments |
| Identifiant | `id` | Identifiant de l'élément chez le service (texte ou nombre) | Éviter les doublons : un élément renvoyé avec le même `type` et le même `id` remplace le précédent |

Tous ces champs sont facultatifs, mais sans événement ni date l'élément ne peut pas être rattaché
automatiquement. Un `id` stable permet de renvoyer un élément corrigé sans créer de doublon.

### Contenu des éléments

À compléter à partir du premier JSON réel du service : champs d'une réponse de satisfaction et d'un
rapport d'incident.

## Réponses et erreurs

Tout code 2xx veut dire que l'envoi est reçu et gardé ; le service n'a pas à le renvoyer.

| Code | Signification | Corps gardé |
| --- | --- | --- |
| 201 Created | JSON lu : chaque élément est enregistré et, si possible, rattaché | Oui |
| 202 Accepted | Corps gardé mais pas lu (pas du JSON, ou forme inattendue) ; la raison est dans `error` | Oui |
| 401 Unauthorized | Clé absente, inconnue ou supprimée | Non |
| 413 Payload Too Large | Corps de plus de 5 Mo | Non |

Réponse 201 :

```json
{
  "stored": true,
  "processed": true,
  "request": 12,
  "received": 2,
  "items": [
    { "id": 41, "type": "satisfaction", "external_id": "tg-8812", "status": "created", "competition": 7, "task": 3 },
    { "id": 42, "type": "incident", "external_id": "inc-17", "status": "updated", "competition": null, "task": null }
  ]
}
```

- `request` : numéro de l'appel chez pgscore, utile pour le retrouver en cas de question.
- `status` : `created` pour un nouvel élément, `updated` s'il remplace un élément de même `type` et même `id`.
- `competition` et `task` : identifiant de la compétition et numéro de la manche trouvés, ou `null` si
  l'élément attend d'être rattaché.

Réponse 202 :

```json
{ "stored": true, "processed": false, "request": 13, "error": "JSON illisible." }
```

Les messages d'erreur suivent la langue de l'en-tête `Accept-Language` (français, anglais, espagnol ou
allemand).

## Rattachement aux compétitions et aux manches

pgscore rattache chaque élément à sa réception, en trois étapes :

1. Il retient les compétitions dont les dates, ou l'une des manches, couvrent le jour indiqué.
2. Parmi elles, il choisit celle dont le nom partage le plus de mots avec le nom de l'événement, sans
   tenir compte des accents ni des majuscules. En cas d'égalité, il ne choisit pas. Sans date, il faut
   qu'au moins les trois quarts des mots se retrouvent.
3. Il prend la manche de ce jour-là dans la compétition, s'il n'y en a qu'une.

Un élément sans manche n'est pas perdu : pgscore réessaie à chaque nouvelle manche ou import de
compétition, et un administrateur peut le rattacher à la main sur `BASE_URL/admin/ingest`. Ce choix est
gardé quand l'élément revient. Pour un bon rattachement, le service envoie le nom complet de l'événement
(par exemple « PWC Gemona 2026 » plutôt que « Open ») et la date du vol concerné.

## Côté pgscore

- Chaque appel authentifié est gardé brut (table `ingest_requests`, les 200 derniers) : adresse, type de
  contenu, taille, corps, code rendu et résultat. L'administrateur les voit et les télécharge sur
  `BASE_URL/admin/ingest`.
- Chaque élément lu est gardé en JSON (table `task_reports`) avec son type, son identifiant, l'événement,
  la date, la compétition et la manche trouvées.
- L'organisateur voit les éléments d'une manche dans l'onglet « Éditer » de la manche. Rien n'est encore
  affiché sur la page publique.

## Exemples

Vérifier la clé et voir les compétitions connues :

```sh
curl -H "Authorization: Bearer pgsi_xxxxxxxx" BASE_URL/api/ingest
```

Envoyer deux éléments (le contenu exact des éléments reste à fixer) :

```sh
curl -X POST BASE_URL/api/ingest \
  -H "Authorization: Bearer pgsi_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '[
    { "type": "satisfaction", "id": "tg-8812", "event": "PWC Gemona 2026", "date": "2026-07-28" },
    { "type": "incident", "id": "inc-17", "event": "PWC Gemona 2026", "date": "2026-07-28T14:32:00Z" }
  ]'
```
