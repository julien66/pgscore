import type { FC } from "hono/jsx";
import type { ApiTokenRow } from "../auth.js";
import type { User } from "../db.js";
import { locale, t } from "../i18n.js";
import { Ic, Bi, Layout, GoogleG, ErrorBox } from "./layout.js";

export const LoginPage: FC<{ providers: Array<{ href: string; label: string }>; devLogin: boolean; error?: string | null }> = ({
  providers,
  devLogin,
  error,
}) => (
  <Layout title={t("Connexion")}>
    <div class="center">
      <img src="/logo.svg" alt="" width="72" height="72" />
      <h1>pgscore</h1>
      <p class="muted">{t("Contrôle et scoring des compétitions de parapente cross-country.")}</p>
      <ErrorBox message={error} />
      {providers.map((p) => (
        <p>
          <a class="btn gbtn" href={p.href}>
            <GoogleG />
            {p.label}
          </a>
        </p>
      ))}
      {!providers.length && !devLogin ? (
        <div class="note">{t("Aucun service de connexion n'est configuré (variables GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET).")}</div>
      ) : null}
      {devLogin ? (
        <form method="post" action="/auth/dev" class="card mt" style="text-align:left">
          <h2><Ic n="key" c="gray" />{t("Connexion de développement")}</h2>
          <p class="small muted">{t("Active seulement avec DEV_LOGIN=1, pour tester sans Google.")}</p>
          <label>{t("E-mail")}</label>
          <input type="email" name="email" required value="dev@pgscore.local" />
          <label class="mt">{t("Nom")}</label>
          <input type="text" name="name" value={t("Organisateur test")} />
          <p>
            <button class="primary">
              <Bi n="login" />
              {t("Entrer")}
            </button>
          </p>
        </form>
      ) : null}
    </div>
  </Layout>
);

/** Mon compte : clés d'API pour les programmes (import et export de compétitions). */
export const AccountPage: FC<{ user: User; tokens: ApiTokenRow[]; baseUrl: string; token: string | null; error: string | null }> = ({ user, tokens, baseUrl, token, error }) => (
  <Layout title={t("Mon compte")} user={user}>
    <div class="crumbs">
      <a href="/">{t("Compétitions")}</a>
    </div>
    <h1>{t("Mon compte")}</h1>
    <p class="muted">{user.email}</p>
    <ErrorBox message={error} />
    <div class="card">
      <h2><Ic n="key" c="purple" />{t("Clés d'API")}</h2>
      <p class="small muted">
        {t("Une clé permet à un programme d'agir en votre nom : importer des compétitions et modifier les vôtres. Gardez-la secrète ; supprimez-la si elle a pu fuiter.")}{" "}
        <a href="/api">{t("Documentation de l'API")}</a>
      </p>
      {token ? (
        <div class="note">
          <p>{t("Nouvelle clé, affichée une seule fois : copiez-la maintenant.")}</p>
          <pre class="code">{token}</pre>
          <pre class="code">{`curl -H "Authorization: Bearer ${token}" ${baseUrl}/api/competitions`}</pre>
        </div>
      ) : null}
      {tokens.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("Nom")}</th>
              <th>{t("Créée le")}</th>
              <th>{t("Dernière utilisation")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((k) => (
              <tr>
                <td>{k.name}</td>
                <td>{new Date(k.created_at).toLocaleString(locale())}</td>
                <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString(locale()) : t("jamais")}</td>
                <td class="n">
                  <form method="post" action={`/account/tokens/${k.id}/delete`}>
                    <button class="link">
                      <Bi n="trash" /> {t("Supprimer")}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form method="post" action="/account/tokens" class="row mt">
        <input type="text" name="name" placeholder={t("Nom de la clé (ex. script d'export)")} style="max-width:320px" required />
        <button class="primary">
          <Bi n="plus" />
          {t("Créer une clé")}
        </button>
      </form>
    </div>
  </Layout>
);

/** Documentation de l'API, avec des exemples prêts à copier. */
export const ApiDocPage: FC<{ user: User | null; baseUrl: string }> = ({ user, baseUrl }) => {
  const K = "pgs_xxxxxxxx";
  return (
    <Layout title={t("API")} user={user}>
      <div class="crumbs">
        <a href="/">{t("Compétitions")}</a>
      </div>
      <h1>{t("API")}</h1>
      <div class="card doc">
        <p>
          {t("Les lectures sont libres. Les écritures demandent une clé d'API, créée dans")} <a href="/account">{t("Mon compte")}</a>{" "}
          {t("et envoyée dans l'en-tête Authorization.")}
        </p>
        <pre class="code">{`Authorization: Bearer ${K}`}</pre>

        <h2>{t("Lister les compétitions")}</h2>
        <pre class="code">{`curl ${baseUrl}/api/competitions`}</pre>
        <p class="small muted">{t("Pour chaque compétition : id, nom, lieu, dates, adresse, date du dernier calcul, et si la clé peut la modifier.")}</p>

        <h2>{t("Exporter une compétition")}</h2>
        <pre class="code">{`curl -o gemona.pgscore.zip ${baseUrl}/api/competitions/12/export\ncurl -o gemona.pgscore.zip "${baseUrl}/api/competitions/12/export?tracks=0"   # ${t("sans les traces")}`}</pre>
        <p class="small muted">
          {t("Archive ZIP : competition.json (réglages, espace aérien, pilotes, classements, manches, décisions, liste des traces et derniers résultats) et les fichiers IGC tels que reçus, sous tracks/m<numéro>/<empreinte SHA-256>.igc.")}
        </p>

        <h2>{t("Importer une compétition")}</h2>
        <pre class="code">{`curl -H "Authorization: Bearer ${K}" --data-binary @gemona.pgscore.zip \\\n     -H "Content-Type: application/zip" ${baseUrl}/api/competitions/import`}</pre>
        <p class="small muted">
          {t("Crée une nouvelle compétition qui vous appartient, résultats compris (sans relancer de calcul). Réponse : id, adresse, nombre de manches, pilotes et traces. L'empreinte de chaque fichier IGC est vérifiée.")}
        </p>

        <h2>{t("Échanger avec FS (format FSDB)")}</h2>
        <pre class="code">{`curl -o gemona.fsdb ${baseUrl}/api/competitions/12/fsdb\ncurl -o gemona.fsdb.zip ${baseUrl}/api/competitions/12/fsdb.zip   # ${t("avec les traces")}\ncurl -H "Authorization: Bearer ${K}" --data-binary @comp.fsdb \\\n     -H "Content-Type: application/xml" ${baseUrl}/api/competitions/import`}</pre>
        <p class="small muted">
          {t("Le même point d'import reconnaît le FSDB (fichier .fsdb seul, ou ZIP contenant le .fsdb et ses dossiers de traces). Sont reprises : la compétition, la formule, les pilotes, les catégories (en classements), les manches et les pénalités saisies. Les résultats calculés par FS ne sont pas repris : le calcul est relancé dans pgscore.")}
        </p>

        <h2 id="ingest">{t("Service externe : retours des pilotes et incidents")}</h2>
        <p class="small muted">
          {t("Un service externe (bot Telegram de la compétition…) envoie des données sur une manche avec une clé d'envoi « pgsi_… », créée dans l'onglet « Éditer » de la compétition. Cette clé ne vaut que pour sa compétition et ne permet rien d'autre.")}
        </p>
        <pre class="code">{`curl -H "Authorization: Bearer pgsi_xxxxxxxx" ${baseUrl}/api/ingest   # ${t("compétition et manches de la clé")}

curl -H "Authorization: Bearer pgsi_xxxxxxxx" -H "Content-Type: application/json" \\
     ${baseUrl}/api/ingest/tasks/3 -d '[
  { "type": "satisfaction", "id": "tg-8812", "pilot": "42", "score": 4, "comment": "Belle manche" },
  { "type": "incident", "id": "inc-17", "severity": "accident", "pilot": "105",
    "time": "2026-07-28T14:32:00Z", "lat": 46.27, "lon": 13.14, "description": "Atterrissage dans les arbres, pilote indemne" }
]'`}</pre>
        <p class="small muted">
          {t("Le corps est un objet JSON, une liste d'objets ou { \"items\": [...] } (1 000 éléments et 1 Mo au plus). « type » et « id » sont facultatifs ; le reste de l'objet est gardé tel quel. Un élément renvoyé avec le même type et le même id remplace le précédent. Réponses : 201 avec, pour chaque élément, created ou updated ; 401 clé absente ou inconnue ; 404 manche introuvable ; 400 JSON illisible ; 413 envoi trop gros.")}
        </p>

        <h2>{t("Autres actions")}</h2>
        <p class="small muted">
          {t("Avec la clé, un programme peut aussi utiliser les formulaires du site (envoi de traces, calcul, officialisation…) sur les compétitions qu'il a le droit de modifier.")}
        </p>
      </div>
    </Layout>
  );
};

export const AboutPage: FC<{ user: User | null }> = ({ user }) => (
  <Layout title={t("À propos")} user={user}>
    <div class="about">
      <h1 class="about-title">
        <img src="/logo.svg" alt="" width="48" height="48" />
        {t("À propos de pgscore")}
      </h1>
      <p class="lead">
        {t("pgscore est un logiciel de contrôle des traces et de scoring des compétitions de parapente cross-country. Il applique la formule GAP du Sporting Code FAI Section 7F (édition 2026), dans un navigateur, sans rien installer.")}
      </p>

      <div class="pill2">
        <div class="card">
          <h2><Ic n="zap" c="blue" />{t("Un outil moderne")}</h2>
          <p>
            {t("Les outils de référence ont fait leurs preuves, mais ils datent : FS est un logiciel Windows à installer sur le poste du scoreur, AirScore est né en 2007 en Perl et PHP. pgscore repart de zéro avec les technologies et les règles d'aujourd'hui.")}
          </p>
          <ul>
            <li>{t("Une application web : le scoreur, les pilotes et le public voient les mêmes résultats, en direct, sur ordinateur comme sur téléphone.")}</li>
            <li>{t("Les règles 2026 : formule GAP 2026 de la CIVL ou de la PWCA, manches arrêtées, FTV, espaces aériens, pénalités et décisions tracées.")}</li>
            <li>{t("Des calculs vérifiés : sur 7 manches de la PWCA (SVL) et la manche 1 du French Open 2026 (FS), environ 570 pilotes, les points tombent au dixième près.")}</li>
            <li>{t("Les formats du terrain : QR code et fichier XCTrack, traces IGC, espaces aériens OpenAir, import et export FSDB pour FS.")}</li>
            <li>{t("Des sorties prêtes à publier : classements extraits (féminin, nations, sport…), CSV, impression A4, visualisation 3D des vols.")}</li>
            <li>{t("Une API pour brancher d'autres outils : export et import de compétitions entières.")}</li>
          </ul>
        </div>
        <div class="card">
          <h2><Ic n="unlock" c="green" />{t("Libre et indépendant")}</h2>
          <p>
            {t("pgscore est un logiciel libre et open source : son code est public, chacun peut le lire, vérifier comment les points sont calculés, le corriger et l'améliorer.")}{" "}
            {t("Il est publié sous licence GNU AGPL-3.0 : toute version modifiée mise en ligne doit, elle aussi, publier son code.")}
          </p>
          <ul>
            <li>{t("Transparent : un résultat se vérifie en lisant le code, pas en faisant confiance à une boîte noire.")}</li>
            <li>{t("Indépendant : aucun éditeur commercial, aucune licence à payer, aucune dépendance à un service fermé.")}</li>
            <li>{t("Ouvert : vos données vous appartiennent. Une compétition s'exporte en entier, traces comprises, dans un format documenté.")}</li>
            <li>{t("Partagé : un club, une ligue ou une fédération peut l'installer sur son propre serveur.")}</li>
          </ul>
        </div>
      </div>

      <div class="card">
        <h2><Ic n="heart" c="pink" />{t("Sur les épaules des pionniers")}</h2>
        <p>
          {t("pgscore doit beaucoup à ceux qui l'ont précédé. CompCheck™ d'Ulric Jessop et SVL de Daniel Dimov sont des références : l'évolution et l'histoire du parapente de compétition ont été portées par leurs outils, à une époque où créer un logiciel demandait bien plus d'efforts qu'aujourd'hui. Merci à eux.")}
        </p>
        <p>
          {t("Merci aussi à Joerg Ewald : en plus de maintenir FS, il a travaillé sans relâche à décrire les standards de scoring. C'est ce travail qui rend possibles aujourd'hui les comparaisons entre logiciels et les initiatives open source comme pgscore.")}
        </p>
        <p>
          {t("Un bon logiciel de scoring ouvert à toute la communauté, c'est aussi la possibilité de faire évoluer la compétition elle-même : tester de nouvelles règles et de nouveaux formats compétitifs bien plus facilement, les appliquer à des manches réelles et comparer les classements obtenus.")}
        </p>
      </div>

      <div class="card">
        <h2><Ic n="users" c="amber" />{t("Qui porte le projet")}</h2>
        <p>
          {t("pgscore est porté par le travail de la FFVL (Fédération française de vol libre) et de Julien Garcia. Il est développé pour les compétitions de parapente de tous niveaux, de la compétition de club à la Coupe du monde.")}
        </p>
        <p class="small muted">
          {t("Code source, questions et contributions :")} <a href="https://github.com/julien66/pgscore">github.com/julien66/pgscore</a>
        </p>
      </div>
    </div>
  </Layout>
);
