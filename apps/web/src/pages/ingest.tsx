import type { FC } from "hono/jsx";
import type { User } from "../db.js";
import { locale, t } from "../i18n.js";
import type { IngestKeyRow, IngestRequestRow, ReportRow } from "../reports.js";
import { Bi, ErrorBox, Ic, Layout } from "./layout.js";

const when = (ms: number) => new Date(ms).toLocaleString(locale());

/** JSON reçu, replié. */
export const ReportJson: FC<{ payload: string }> = ({ payload }) => (
  <details>
    <summary class="small">{t("JSON reçu")}</summary>
    <pre class="code">{JSON.stringify(JSON.parse(payload), null, 2)}</pre>
  </details>
);

/** Administration du service externe : clés d'envoi, et éléments qu'on n'a pas su rattacher à une manche. */
export const IngestAdminPage: FC<{
  user: User;
  baseUrl: string;
  keys: IngestKeyRow[];
  pending: Array<ReportRow & { competition_name: string | null }>;
  competitions: Array<{ id: number; name: string; start_date: string | null }>;
  requests: Array<Omit<IngestRequestRow, "body">>;
  token: string | null;
  error: string | null;
  notice: string | null;
}> = ({ user, baseUrl, keys, pending, competitions, requests, token, error, notice }) => (
  <Layout title={t("Service externe")} user={user}>
    <div class="crumbs">
      <a href="/">{t("Compétitions")}</a> › <a href="/account">{t("Mon compte")}</a>
    </div>
    <h1>{t("Service externe")}</h1>
    <ErrorBox message={error} />
    {notice ? <div class="note">{notice}</div> : null}

    <div class="card">
      <h2><Ic n="key" c="purple" />{t("Clés d'envoi")}</h2>
      <p class="small muted">
        {t("Une clé d'envoi permet au service externe (bots Telegram des compétitions) d'envoyer des données sur les manches : satisfaction des pilotes, accidents et incidents. Elle ne sert qu'à cela. Gardez-la secrète ; supprimez-la si elle a pu fuiter.")}{" "}
        <a href="/api#ingest">{t("Documentation de l'API")}</a>
      </p>
      {token ? (
        <div class="note">
          <p>{t("Nouvelle clé, affichée une seule fois : copiez-la maintenant.")}</p>
          <pre class="code">{token}</pre>
          <pre class="code">{`curl -H "Authorization: Bearer ${token}" ${baseUrl}/api/ingest`}</pre>
        </div>
      ) : null}
      {keys.length ? (
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
            {keys.map((k) => (
              <tr>
                <td>{k.name}</td>
                <td>{when(k.created_at)}</td>
                <td>{k.last_used_at ? when(k.last_used_at) : t("jamais")}</td>
                <td class="n">
                  <form method="post" action={`/admin/ingest/keys/${k.id}/delete`}>
                    <button class="link" data-confirm={t("Supprimer cette clé ? Le service qui l'utilise ne pourra plus rien envoyer.")}>
                      <Bi n="trash" /> {t("Supprimer")}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form method="post" action="/admin/ingest/keys" class="row mt">
        <input type="text" name="name" placeholder={t("Nom de la clé (ex. bot Telegram)")} style="max-width:320px" required />
        <button class="primary">
          <Bi n="plus" />
          {t("Créer une clé")}
        </button>
      </form>
    </div>

    <div class="card" id="requests">
      <h2><Ic n="download" c="blue" />{t("Derniers appels reçus ({n})", { n: requests.length })}</h2>
      <p class="small muted">
        {t("Chaque appel authentifié est gardé tel que reçu, même si son contenu n'a pas pu être lu : de quoi voir le format réel du service. Les 200 derniers sont gardés.")}
      </p>
      {requests.length ? (
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Reçu")}</th>
                <th>{t("Clé")}</th>
                <th>{t("Adresse")}</th>
                <th>{t("Taille")}</th>
                <th>{t("Résultat")}</th>
                <th>{t("Contenu")}</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr>
                  <td class="small muted">{when(r.received_at)}</td>
                  <td class="small">{r.key_name ?? "–"}</td>
                  <td class="small">
                    <code>{r.path}</code>
                    {r.content_type ? <div class="muted">{r.content_type}</div> : null}
                  </td>
                  <td class="n small">{t("{n} octets", { n: r.size })}</td>
                  <td class="small">
                    {r.status ?? "–"} {r.outcome ?? ""}
                  </td>
                  <td class="small">
                    <a href={`/admin/ingest/requests/${r.id}`} target="_blank" rel="noopener">{t("voir")}</a> ·{" "}
                    <a href={`/admin/ingest/requests/${r.id}?download=1`}>{t("télécharger")}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">{t("Aucun appel reçu pour l'instant.")}</p>
      )}
    </div>

    <div class="card" id="pending">
      <h2><Ic n="filter" c="amber" />{t("Éléments sans manche ({n})", { n: pending.length })}</h2>
      <p class="small muted">
        {t("Chaque élément est rattaché à la compétition dont le nom ressemble à celui de l'événement et dont les dates couvrent le jour indiqué, puis à la manche de ce jour. Ceux-ci n'ont pas trouvé de manche : compétition ou manche pas encore créée, nom trop différent, date absente. Le rattachement est retenté à chaque nouvelle manche ; vous pouvez aussi le faire à la main.")}
      </p>
      <form method="post" action="/admin/ingest/rematch">
        <button>
          <Bi n="refresh" />
          {t("Relancer le rattachement")}
        </button>
      </form>
      {pending.length ? (
        <div class="scroll mt">
          <table>
            <thead>
              <tr>
                <th>{t("Type")}</th>
                <th>{t("Événement")}</th>
                <th>{t("Date")}</th>
                <th>{t("Reçu")}</th>
                <th>{t("Contenu")}</th>
                <th>{t("Rattacher à")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr>
                  <td>
                    {r.type ?? "–"}
                    {r.external_id ? <div class="small muted">{r.external_id}</div> : null}
                  </td>
                  <td>{r.event_name ?? "–"}</td>
                  <td>{r.event_date ?? "–"}</td>
                  <td class="small muted">{when(r.updated_at)}</td>
                  <td>
                    <ReportJson payload={r.payload} />
                  </td>
                  <td>
                    <form method="post" action={`/admin/ingest/reports/${r.id}`} class="row">
                      <select name="competition">
                        <option value="">–</option>
                        {competitions.map((c) => (
                          <option value={String(c.id)} selected={c.id === r.competition_id}>
                            {c.name}
                            {c.start_date ? ` (${c.start_date})` : ""}
                          </option>
                        ))}
                      </select>
                      <input type="number" name="task" min="1" class="in-s" placeholder={t("manche")} />
                      <button class="link">{t("Rattacher")}</button>
                    </form>
                  </td>
                  <td>
                    <form method="post" action={`/admin/ingest/reports/${r.id}/delete`}>
                      <button class="link" data-confirm={t("Supprimer cet élément reçu ?")}>
                        {t("Supprimer")}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  </Layout>
);
