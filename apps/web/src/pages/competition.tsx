import type { FC } from "hono/jsx";
import { type Task } from "@pgscore/engine";
import type { CompetitionRow, PilotRow, TaskRow, User } from "../db.js";
import { GAP_PROFILES, PENALTY_RULES, type CompetitionSettings } from "../settings.js";
import { km, timeZoneGroups } from "../time.js";
import { t } from "../i18n.js";
import { PILOT_COLUMNS } from "../pilots.js";
import { Ic, Bi, Layout, ErrorBox, dateRange } from "./layout.js";
import { CsvLink, fr } from "./parts.js";
import { type Board, StandingsBoard } from "./standings.js";

export interface CompetitionFormValues {
  name: string;
  location: string;
  start_date: string;
  end_date: string;
  settings: CompetitionSettings;
}

export const CompetitionFields: FC<{ v: CompetitionFormValues }> = ({ v }) => {
  const s = v.settings;
  return (
    <>
      <div class="grid">
        <div>
          <label>{t("Nom")}</label>
          <input type="text" name="name" required value={v.name} />
        </div>
        <div>
          <label>{t("Lieu")}</label>
          <input type="text" name="location" value={v.location} />
        </div>
        <div>
          <label>{t("Début")}</label>
          <input type="date" name="start_date" value={v.start_date} />
        </div>
        <div>
          <label>{t("Fin")}</label>
          <input type="date" name="end_date" value={v.end_date} />
        </div>
      </div>
      <h2 class="mt"><Ic n="sliders" c="gray" />{t("Paramètres de la formule (S7F, chapitre 5)")}</h2>
      <div class="grid">
        <div>
          <label>{t("Distance nominale (km)")}</label>
          <input type="number" step="0.1" min="0" name="nominalDistance" value={String(s.nominalDistance / 1000)} />
        </div>
        <div>
          <label>{t("Distance minimale (km)")}</label>
          <input type="number" step="0.1" min="0" name="minimumDistance" value={String(s.minimumDistance / 1000)} />
        </div>
        <div>
          <label>{t("Temps nominal (min)")}</label>
          <input type="number" step="1" min="1" name="nominalTime" value={String(s.nominalTime / 60)} />
        </div>
        <div>
          <label>{t("Facteur FTV (%)")}</label>
          <input type="number" step="1" min="0" max="100" name="ftvFactor" value={String(Math.round(s.ftvFactor * 100))} />
        </div>
        <div>
          <label>{t("Formule de points")}</label>
          <select name="gapProfile">
            {Object.entries(GAP_PROFILES).map(([k, l]) => (
              <option value={k} selected={s.gapProfile === k}>
                {t(l)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>{t("Pénalité d'espace aérien")}</label>
          <select name="airspacePenaltyRule">
            {Object.entries(PENALTY_RULES).map(([k, l]) => (
              <option value={k} selected={s.airspacePenaltyRule === k}>
                {t(l)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>{t("Fuseau horaire du site")}</label>
          <select name="timeZone">
            {timeZoneGroups(s.timeZone).map((g) => (
              <optgroup label={g.region}>
                {g.zones.map((z) => (
                  <option value={z.id} selected={s.timeZone === z.id}>
                    {z.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div style="align-self:end">
          <label class="check">
            <input type="checkbox" name="roundAirspaceLimits" checked={s.roundAirspaceLimits} /> {t("Arrondir au mètre les limites en pieds (SVL)")}
          </label>
        </div>
      </div>
    </>
  );
};

export const NewCompetitionPage: FC<{ user: User | null; v: CompetitionFormValues; error?: string | null; civl?: boolean }> = ({ user, v, error, civl }) => (
  <Layout title={t("Nouvelle compétition")} user={user}>
    <div class="crumbs">
      <a href="/">{t("Compétitions")}</a>
    </div>
    <h1>{t("Nouvelle compétition")}</h1>
    <ErrorBox message={error} />
    <div class="card">
      <h2><Ic n="upload" c="blue" />{t("Importer une compétition existante")}</h2>
      <p class="small muted">{t("Depuis un fichier : archive pgscore (ZIP) ou fichier FS (.fsdb, seul ou en ZIP avec ses traces).")}</p>
      <form
        method="post"
        action="/competitions/import"
        enctype="multipart/form-data"
        class="upload"
        data-busy={t("Archive reçue. Lecture de la compétition et rangement des traces : cela peut prendre une minute pour une grosse archive, puis le calcul des manches démarre.")}
      >
        <div class="row">
          <input type="file" name="file" accept=".zip,.json,.fsdb" required />
          <button class="primary">
            <Bi n="upload" />
            {t("Importer")}
          </button>
        </div>
      </form>
      {civl ? (
        <>
      <p class="small muted mt">{t("Ou depuis civlcomps.org : adresse de la page de résultats de l'événement. Les manches, les pilotes, les pénalités, les absents et les traces publiées sont repris ; vérifiez ensuite le type de goal de chaque manche, que civlcomps ne publie pas.")}</p>
      <form
        method="post"
        action="/competitions/import"
        class="civl-import"
        data-busy={t("Lecture des manches sur civlcomps.org et téléchargement des traces : comptez une à deux minutes, puis le calcul des manches démarre.")}
      >
        <div class="row">
          <input type="url" name="civl_url" placeholder="https://civlcomps.org/event/german-open-2026/results" required style="flex:1" />
          <button class="primary">
            <Bi n="upload" />
            {t("Importer")}
          </button>
        </div>
      </form>
        </>
      ) : null}
      <p class="small muted mt">{t("La compétition est créée avec ses manches, ses pilotes et ses traces, puis les points sont calculés.")}</p>
    </div>
    <script src="/static/run.js" />
    <h2 class="mt">{t("Ou créer une compétition vide")}</h2>
    <form method="post" action="/competitions" enctype="multipart/form-data" class="card">
      <CompetitionFields v={v} />
      <h2 class="mt"><Ic n="shield" c="red" />{t("Espace aérien")}</h2>
      <label>{t("Fichier OpenAir (facultatif, modifiable ensuite)")}</label>
      <input type="file" name="airspace" accept=".txt,.air,.openair" />
      <p class="mt">
        <button class="primary">
          <Bi n="plus" />
          {t("Créer la compétition")}
        </button>
      </p>
    </form>
  </Layout>
);

export const CompetitionPage: FC<{
  user: User | null;
  c: CompetitionRow;
  v: CompetitionFormValues;
  tasks: TaskRow[];
  board: Board;
  pilots: PilotRow[];
  /** Pilotes vus dans les traces, pas encore dans la liste des inscrits. */
  trackPilots?: Array<{ pilot_key: string; name: string }>;
  airspaceCount: number | null;
  error?: string | null;
  notice?: string | null;
  edit?: boolean;
  /** Créateur de la compétition ou administrateur : sinon, lecture seule. */
  canEdit: boolean;
  /** Super-administrateur : peut supprimer la compétition. */
  canDelete?: boolean;
  /** Calculs en cours ou en attente (après un import) : dernier calcul de chaque manche. */
  runs?: CompRun[] | null;
}> = ({ user, c, v, tasks, board, pilots, trackPilots, airspaceCount, error, notice, edit, canEdit, canDelete, runs }) => (
  <Layout title={edit ? `${t("Éditer")} · ${c.name}` : c.name} user={user}>
    <div class="crumbs">
      <a href="/">{t("Compétitions")}</a>
    </div>
    <h1>{c.name}</h1>
    <nav class="tabs">
      <a href={`/competitions/${c.id}`} class={edit ? "" : "on"}>
        <Bi n="route" />
        {t("Manches et classements")}
      </a>
      {canEdit ? (
        <a href={`/competitions/${c.id}/edit`} class={edit ? "on" : ""}>
          <Bi n="sliders" />
          {t("Éditer")}
        </a>
      ) : null}
    </nav>
    <ErrorBox message={error} />
    {notice ? <div class="note">{notice}</div> : null}
    {runs ? <CompRuns c={c} runs={runs} /> : null}
    {edit && canEdit ? (
      <>
        <CompetitionEdit c={c} v={v} pilots={pilots} trackPilots={trackPilots ?? []} airspaceCount={airspaceCount} open={Boolean(error)} />
        {canDelete ? (
          <div class="card danger" id="delete">
            <h2><Ic n="trash" c="red" />{t("Supprimer la compétition")}</h2>
            <p class="small muted">
              {t("Suppression définitive : manches, pilotes, traces, calculs, décisions et classements disparaissent. Exportez d'abord la compétition si vous voulez en garder une copie. Pour confirmer, recopiez son nom : {name}", { name: c.name })}
            </p>
            <form
              method="post"
              action={`/competitions/${c.id}/delete`}
              class="row"
              onsubmit={`return confirm(${JSON.stringify(t("Supprimer définitivement « {name} » et toutes ses données ? Cette action ne peut pas être annulée.", { name: c.name }))})`}
            >
              <input type="text" name="confirm" required autocomplete="off" placeholder={c.name} />
              <button class="danger">
                <Bi n="trash" />
                {t("Supprimer définitivement")}
              </button>
            </form>
          </div>
        ) : null}
      </>
    ) : (
      <CompetitionMain c={c} tasks={tasks} board={board} />
    )}
  </Layout>
);

export interface CompRun {
  task_id: number;
  number: number;
  status: string;
  step: string | null;
  done: number;
  total: number;
  error: string | null;
}

/** Avancement des calculs lancés après un import ; comp-runs.js le met à jour et recharge la page à la fin. */
const CompRuns: FC<{ c: CompetitionRow; runs: CompRun[] }> = ({ c, runs }) => (
  <div class="card" id="comp-runs" data-url={`/competitions/${c.id}/runs.json`}>
    <h2><span class="spin" /> {t("Calcul des manches")}</h2>
    <p class="small muted runs-head">
      {t("Calcul des manches : {done} sur {total}. Vous pouvez rester sur cette page, les résultats s'afficheront à la fin.", {
        done: runs.filter((r) => r.status === "done").length,
        total: runs.length,
      })}
    </p>
    <ul class="list runs">
      {runs.map((r) => (
        <li>
          <strong>{t("Manche {n}", { n: r.number })}</strong> <span class="small muted">{r.status === "done" ? t("calculée") : r.status === "queued" ? t("en attente") : t("calcul en cours")}</span>
        </li>
      ))}
    </ul>
    <script src="/static/comp-runs.js" />
  </div>
);

const CompetitionMain: FC<{ c: CompetitionRow; tasks: TaskRow[]; board: Board }> = ({ c, tasks, board }) => (
  <>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2><Ic n="route" c="blue" />{t("Manches")}</h2>
        {board.canEdit ? (
          <div class="row">
            {tasks.length ? (
              <form method="post" action={`/competitions/${c.id}/runs`} title={t("Relance le calcul de chaque manche qui a des traces, l'une après l'autre, avec les réglages actuels.")}>
                <button>
                  <Bi n="refresh" />
                  {t("Recalculer toutes les manches")}
                </button>
              </form>
            ) : null}
            <a class="btn primary" href={`/competitions/${c.id}/tasks/new`}>
              <Bi n="plus" />
              {t("Nouvelle manche")}
            </a>
          </div>
        ) : null}
      </div>
      {tasks.length ? (
        <ul class="list">
          {tasks.map((tk) => {
            const task = JSON.parse(tk.task) as Task;
            const info = board.s.tasks.find((x) => x.t.id === tk.id);
            return (
              <li class="task">
                <a href={`/tasks/${tk.id}`}>
                  <strong>{t("Manche {n}", { n: tk.number })}</strong>
                </a>
                <span class="muted small">
                  {[
                    tk.date ? dateRange(tk.date, null) : null,
                    task.type === "race" ? t("race") : t("time trial"),
                    task.stopAnnouncement ? t("arrêtée") : null,
                    info?.goal !== undefined ? (info.goal === 1 ? t("{n} pilote au goal", { n: 1 }) : t("{n} pilotes au goal", { n: info.goal })) : null,
                    info?.winner !== undefined ? t("FTV {pct} %", { pct: fr(info.winner / 10, 1) }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {!board.canEdit ? (
                  tk.official === 1 ? <span class="small muted official">{t("officielle")}</span> : null
                ) : (
                <form method="post" action={`/tasks/${tk.id}/official`} class="official">
                  <input type="hidden" name="back" value="competition" />
                  <label class="check">
                    <input type="checkbox" name="official" value="1" checked={tk.official === 1} /> {t("officielle")}
                  </label>
                  <noscript>
                    <button class="link">{t("Enregistrer")}</button>
                  </noscript>
                </form>
                )}
                {info?.calculatedAt ? (
                  <span class="small task-rk">
                    <a href={`/tasks/${tk.id}#results`}>{t("Général")}</a>
                    {board.rankings.map((x) => (
                      <>
                        {" · "}
                        <a href={`/tasks/${tk.id}?r=${x.r.row.id}#results`}>{t(x.r.row.name)}</a>
                      </>
                    ))}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="muted">{t("Pas encore de manche.")}</p>
      )}
    </div>

    <div class="card" id="standings" data-swap>
      <h2><Ic n="trophy" c="amber" />{t("Classements")}</h2>
      <StandingsBoard c={c} b={board} />
    </div>
    <p class="small muted">
      {t("Télécharger la compétition :")}{" "}
      <a class="act" href={`/api/competitions/${c.id}/export`}>
        <Bi n="download" /> {t("archive complète avec les traces (ZIP)")}
      </a>{" "}
      ·{" "}
      <a class="act" href={`/api/competitions/${c.id}/export?tracks=0`}>
        {t("sans les traces")}
      </a>{" "}
      · <a href="/api">{t("API")}</a>
      <br />
      {t("Pour FS (format FSDB) :")}{" "}
      <a class="act" href={`/api/competitions/${c.id}/fsdb`}>
        <Bi n="download" /> {t("fichier .fsdb")}
      </a>{" "}
      ·{" "}
      <a class="act" href={`/api/competitions/${c.id}/fsdb.zip`}>
        {t("avec les traces (ZIP)")}
      </a>
    </p>
    <script src="/static/competition.js" />
  </>
);

/** Onglet « Éditer » : réglages de la compétition, espace aérien, pilotes. */
const CompetitionEdit: FC<{ c: CompetitionRow; v: CompetitionFormValues; pilots: PilotRow[]; trackPilots: Array<{ pilot_key: string; name: string }>; airspaceCount: number | null; open: boolean }> = ({
  c,
  v,
  pilots,
  trackPilots,
  airspaceCount,
  open,
}) => (
  <>
    <details class="card fold" id="settings" open={open}>
      <summary>
        <h2>
          <Ic n="sliders" c="gray" />
          {t("Compétition")}
          <span class="muted small">
            {t(GAP_PROFILES[v.settings.gapProfile]).split(" (")[0]} ·{" "}
            {t("FTV {ftv} % · nominale {km} km, {min} min", {
              ftv: Math.round(v.settings.ftvFactor * 100),
              km: fr(v.settings.nominalDistance / 1000, v.settings.nominalDistance % 1000 ? 1 : 0),
              min: v.settings.nominalTime / 60,
            })}
          </span>
        </h2>
      </summary>
      <form method="post" action={`/competitions/${c.id}`}>
        <CompetitionFields v={v} />
        <p class="mt">
          <button class="primary">
            <Bi n="save" />
            {t("Enregistrer")}
          </button>
        </p>
      </form>
    </details>

    <details class="card fold" id="airspace" open={open}>
      <summary>
        <h2>
          <Ic n="shield" c="red" />
          {t("Espace aérien")}
          <span class="muted small">
            {c.airspace_name
              ? `${c.airspace_name} · ${airspaceCount === 1 ? t("{n} zone", { n: 1 }) : t("{n} zones", { n: airspaceCount ?? 0 })}`
              : t("aucun fichier")}
          </span>
        </h2>
      </summary>
      {c.airspace_name ? null : <p class="muted">{t("Aucun fichier : les traces ne sont pas contrôlées pour l'espace aérien.")}</p>}
      <form method="post" action={`/competitions/${c.id}/airspace`} enctype="multipart/form-data" class="row">
        <input type="file" name="airspace" accept=".txt,.air,.openair" required />
        <button>
          <Bi n="upload" />
          {c.airspace_name ? t("Remplacer") : t("Envoyer")}
        </button>
      </form>
      <p class="small muted">
        {t("Limites lues en AMSL ; niveaux de vol convertis à 1013,25 hPa puis abaissés de 100 m. Les limites AGL sont ignorées.")}
      </p>
    </details>

    <PilotsBlock c={c} pilots={pilots} trackPilots={trackPilots} open={open} />
    <script src="/static/competition.js" />
  </>
);

/** Pilotes inscrits : import FSDB/CSV et tableau modifiable. */
const PilotsBlock: FC<{ c: CompetitionRow; pilots: PilotRow[]; trackPilots: Array<{ pilot_key: string; name: string }>; open: boolean }> = ({ c, pilots, trackPilots, open }) => {
  const women = pilots.filter((p) => p.gender === "F").length;
  const cell = (p: PilotRow | null, key: (typeof PILOT_COLUMNS)[number]["key"]) => {
    const name = p ? `p.${p.id}.${key}` : `new.${key}`;
    const v = p ? p[key] : null;
    if (key === "gender")
      return (
        <select name={name}>
          <option value="" selected={!v}>
            –
          </option>
          <option value="F" selected={v === "F"}>
            F
          </option>
          <option value="M" selected={v === "M"}>
            M
          </option>
        </select>
      );
    const size = key === "pilot_key" || key === "nation" || key === "weight_max" || key === "glider_class" ? "s" : key === "name" ? "l" : "m";
    return <input type="text" name={name} value={v === null ? "" : String(v)} class={`in-${size}`} placeholder={p ? "" : t(PILOT_COLUMNS.find((x) => x.key === key)!.label)} />;
  };
  return (
    <details class="card fold" id="pilots" open={open || trackPilots.length > 0}>
      <summary>
        <h2>
          <Ic n="users" c="purple" />
          {t("Pilotes")}{" "}
          <span class="muted small">
            {pilots.length
              ? `${pilots.length === 1 ? t("{n} inscrit", { n: 1 }) : t("{n} inscrits", { n: pilots.length })}${
                  women ? ` · ${women === 1 ? t("{n} femme", { n: 1 }) : t("{n} femmes", { n: women })}` : ""
                }`
              : t("aucun inscrit")}
            {trackPilots.length ? ` · ${trackPilots.length === 1 ? t("{n} pilote des traces à inscrire", { n: 1 }) : t("{n} pilotes des traces à inscrire", { n: trackPilots.length })}` : ""}
          </span>
        </h2>
      </summary>
      {trackPilots.length ? (
        <p class="note">
          {t(
            "Ces traces n'ont pas de nom de pilote : elles sont proposées en bas du tableau, sous le nom de leur fichier ou de leur instrument. Indiquez le numéro et le nom du pilote, puis enregistrez : la trace suit ce numéro.",
          )}
        </p>
      ) : null}
      <form method="post" action={`/competitions/${c.id}/pilots/import`} enctype="multipart/form-data" class="row">
        <input type="file" name="file" accept=".fsdb,.xml,.csv,.txt" required />
        <button>
          <Bi n="upload" />
          {t("Importer")}
        </button>
        {pilots.length ? <CsvLink href={`/competitions/${c.id}/pilots.csv`} /> : null}
      </form>
      <p class="small muted">
        {t(
          "Fichier FSDB (logiciel FS de la CIVL) ou CSV avec une ligne d'en-tête : numero, nom, genre, nation, civl_id, voile_marque, voile_modele, voile_classe, sellette_marque, sellette_modele, ptv_max_kg, sponsor (seuls numero et nom sont obligatoires ; une colonne « voile » ou « sellette » seule est coupée en marque et modèle). Un pilote déjà inscrit sous le même numéro est mis à jour. Le numéro est celui des traces.",
        )}
      </p>
      <form method="post" action={`/competitions/${c.id}/pilots`}>
        <div class="scroll">
          <table class="pilots">
            <thead>
              <tr>
                {PILOT_COLUMNS.map((col) => (
                  <th>{t(col.label)}</th>
                ))}
                <th>{t("Retirer")}</th>
              </tr>
            </thead>
            <tbody>
              {pilots.map((p) => (
                <tr>
                  {PILOT_COLUMNS.map((col) => (
                    <td>{cell(p, col.key)}</td>
                  ))}
                  <td>
                    <input type="checkbox" name={`del.${p.id}`} value="1" title={t("Retirer ce pilote à l'enregistrement")} />
                  </td>
                </tr>
              ))}
              {trackPilots.map((p, i) => (
                <tr class="from-tracks">
                  {PILOT_COLUMNS.map((col) => {
                    const v = col.key === "pilot_key" ? p.pilot_key : col.key === "name" ? p.name : "";
                    const size = col.key === "pilot_key" || col.key === "nation" || col.key === "weight_max" || col.key === "glider_class" ? "s" : col.key === "name" ? "l" : "m";
                    return (
                      <td>
                        {col.key === "gender" ? (
                          <select name={`add.${i}.gender`}>
                            <option value="">–</option>
                            <option value="F">F</option>
                            <option value="M">M</option>
                          </select>
                        ) : (
                          <input type="text" name={`add.${i}.${col.key}`} value={v} class={`in-${size}`} />
                        )}
                      </td>
                    );
                  })}
                  <td class="small muted">
                    <input type="hidden" name={`from.${i}`} value={p.pilot_key} />
                    <label title={t("Ne pas inscrire ce pilote")}>
                      <input type="checkbox" name={`skip.${i}`} value="1" /> {t("depuis les traces")}
                    </label>
                  </td>
                </tr>
              ))}
              <tr class="new">
                {PILOT_COLUMNS.map((col) => (
                  <td>{cell(null, col.key)}</td>
                ))}
                <td class="small muted">{t("nouveau")}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt">
          <button class="primary">
            <Bi n="save" />
            {t("Enregistrer les pilotes")}
          </button>
        </p>
      </form>
    </details>
  );
};
