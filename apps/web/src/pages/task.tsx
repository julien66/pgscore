import { isPlaceholderPilot } from "../files.js";
import type { FC } from "hono/jsx";
import { type TaskScoring } from "@pgscore/engine";
import type { CompetitionRow, DecisionRow, PilotRow, RunRow, TaskRow, TrackHistoryRow, TrackRow, User } from "../db.js";
import { DECISION_KINDS } from "../decisions.js";
import { GOAL_LINE_ORIENTATIONS, LEADING_ENDS, LEADING_FORMULAS, type CompetitionSettings, type StoredTask } from "../settings.js";
import { km, localTime, utcHmsToLocal } from "../time.js";
import { locale, N_, t } from "../i18n.js";
import { Ic, Bi, Layout, ErrorBox, dateRange } from "./layout.js";
import { goalAltitudeOf } from "./parts.js";
import { RunCard, RunStatus, decisionLabel, TaskDetails, TaskResults } from "./results.js";

export const NewTaskPage: FC<{ user: User | null; c: CompetitionRow; number: number; error?: string | null; date?: string }> = ({
  user,
  c,
  number,
  error,
  date,
}) => (
  <Layout title={t("Nouvelle manche")} user={user}>
    <div class="crumbs">
      <a href="/">{t("Compétitions")}</a> › <a href={`/competitions/${c.id}`}>{c.name}</a>
    </div>
    <h1>{t("Nouvelle manche")}</h1>
    <ErrorBox message={error} />
    <form method="post" action={`/competitions/${c.id}/tasks`} enctype="multipart/form-data" class="card">
      <div class="grid">
        <div>
          <label>{t("Numéro")}</label>
          <input type="number" name="number" min="1" value={String(number)} required />
        </div>
        <div>
          <label>{t("Date")}</label>
          <input type="date" name="date" value={date ?? ""} />
        </div>
      </div>
      <h2 class="mt"><Ic n="map" c="teal" />{t("Définition de la manche")}</h2>
      <p class="small muted">{t("Une seule des trois sources suffit.")}</p>
      <div class="grid">
        <div>
          <label>{t("Fichier XCTrack (.xctsk)")}</label>
          <input type="file" name="xctsk" accept=".xctsk,.json,.txt" />
        </div>
        <div>
          <label>{t("Image du QR code (PNG ou JPEG)")}</label>
          <input type="file" name="qr" accept="image/png,image/jpeg" />
        </div>
      </div>
      <label class="mt">{t("Ou texte du QR code (commence par XCTSK:)")}</label>
      <textarea name="text" placeholder="XCTSK:{...}"></textarea>
      <p class="mt">
        <button class="primary">
          <Bi n="plus" />
          {t("Créer la manche")}
        </button>
      </p>
    </form>
  </Layout>
);

const ROLE: Record<string, string> =
 { takeoff: N_("Décollage"), sss: N_("Départ (SSS)"), turnpoint: N_("Balise"), ess: "ESS", goal: "Goal" };

export const TaskPage: FC<{
  user: User | null;
  c: CompetitionRow;
  t: TaskRow;
  task: StoredTask;
  settings: CompetitionSettings;
  distances: { task: number; launchToEss: number; speedSection: number };
  tracks: TrackRow[];
  history: TrackHistoryRow[];
  decisions: DecisionRow[];
  /** Dessin de la manche (JSON de taskGeometry). */
  geometry: string;
  run: RunRow | null;
  /** Dernier calcul terminé : ses résultats restent affichés pendant un nouveau calcul. */
  done: RunRow | null;
  /** Classements extraits de la compétition, et celui affiché dans les résultats (?r=). */
  rankings: Array<{ id: number; name: string }>;
  ranking: { id: number; members: Set<string> } | null;
  /** Onglet « Détails de la manche » des résultats (?view=details). */
  details?: boolean;
  /** Pilotes inscrits (nation, voile) pour le classement de la manche. */
  registry: PilotRow[];
  running: boolean;
  /** Liste des traces dépliée (après un envoi, un remplacement ou un retrait). */
  openTracks?: boolean;
  error?: string | null;
  notice?: string | null;
  edit?: boolean;
  /** Créateur de la compétition ou administrateur : sinon, lecture seule. */
  canEdit: boolean;
  /** Toutes les manches de la compétition, pour passer de l'une à l'autre. */
  siblings?: Array<{ id: number; number: number; date: string | null }>;
}> = ({ user, c, t: tk, task, settings, distances, tracks, history, decisions, geometry, run, done, rankings, ranking, details, registry, running, error, notice, edit: editTab, canEdit, openTracks, siblings = [] }) => {
  const edit = Boolean(editTab && canEdit);
  const tz = settings.timeZone;
  const loc = (hms?: string) => (hms ? utcHmsToLocal(hms, tk.date, tz) : "");
  const results = done?.results ? (JSON.parse(done.results) as TaskScoring) : null;
  // Traces modifiées après le lancement du dernier calcul : le classement affiché n'en tient pas compte.
  const lastChange = Math.max(0, ...tracks.map((x) => x.uploaded_at), ...history.map((h) => h.ended_at), tk.scoring_changed_at ?? 0);
  const stale = done !== null && lastChange > done.started_at;
  const versions = new Map<string, number>();
  for (const h of history) versions.set(h.pilot_key, (versions.get(h.pilot_key) ?? 0) + 1);
  // Pilotes à plusieurs traces : le dernier calcul dit laquelle a été retenue.
  const perPilot = new Map<string, number>();
  for (const x of tracks) perPilot.set(x.pilot_key, (perPilot.get(x.pilot_key) ?? 0) + 1);
  const chosenTracks: Record<string, string> =
    run?.status === "done" && run.results ? ((JSON.parse(run.results) as { chosenTracks?: Record<string, string> }).chosenTracks ?? {}) : {};
  const when = (ms: number) => `${new Date(ms).toLocaleDateString(locale(), { timeZone: tz, day: "2-digit", month: "2-digit" })} ${localTime(ms, tz)}`;
  const fileUrl = (sha: string) => `/tasks/${tk.id}/files/${sha}`;
  // Lien entre les traces et les pilotes de la compétition : le numéro (pilot_key) de la trace est celui de l'inscrit.
  const reg = new Map(registry.map((p) => [p.pilot_key, p]));
  // Un inscrit d'office sous le nom de sa trace (« albert-nazander ») n'a pas encore de numéro : sa trace compte comme non rattachée.
  const unlinked = tracks.filter((x) => !reg.has(x.pilot_key) || isPlaceholderPilot(reg.get(x.pilot_key)!));
  const pilotsUrl = `/competitions/${c.id}/edit#pilots`;
  return (
    <Layout title={`${edit ? `${t("Éditer")} · ` : ""}${t("Manche {n}", { n: tk.number })} · ${c.name}`} user={user}>
      <div class="crumbs">
        <a href="/">{t("Compétitions")}</a> › <a href={`/competitions/${c.id}`}>{c.name}</a>
      </div>
      <h1>
        {t("Manche {n}", { n: tk.number })}
        {tk.date ? <span class="muted"> · {dateRange(tk.date, null)}</span> : null}
      </h1>
      <nav class="tabs">
        <a href={`/tasks/${tk.id}`} class={edit ? "" : "on"}>
          <Bi n="map" />
          {t("Carte et résultats")}
        </a>
        {canEdit ? (
          <a href={`/tasks/${tk.id}/edit`} class={edit ? "on" : ""}>
            <Bi n="sliders" />
            {t("Éditer")}
          </a>
        ) : null}
        {siblings.length > 1 ? (
          <span class="task-tabs">
            {siblings.map((x) => (
              <a
                href={`/tasks/${x.id}${edit ? "/edit" : ""}`}
                class={x.id === tk.id ? "on" : ""}
                title={`${t("Manche {n}", { n: x.number })}${x.date ? ` · ${dateRange(x.date, null)}` : ""}`}
              >
                {t("M{n}", { n: x.number })}
              </a>
            ))}
          </span>
        ) : null}
      </nav>
      <ErrorBox message={error} />
      {notice ? <div class="note">{notice}</div> : null}

      {edit ? (
        <>
      <details class="card fold" id="task-settings" open={Boolean(error)}>
        <summary>
          <h2>
            <Ic n="sliders" c="gray" />
            {t("Manche")}
            <span class="muted small">{task.stopAnnouncement ? t("arrêtée à {time}", { time: loc(task.stopAnnouncement) }) : tk.date ? dateRange(tk.date, null) : ""}</span>
          </h2>
        </summary>
        <form method="post" action={`/tasks/${tk.id}`} class="grid">
          <div>
            <label>{t("Date")}</label>
            <input type="date" name="date" value={tk.date ?? ""} />
          </div>
          <div>
            <label>{t("Type de manche")}</label>
            <select name="type">
              <option value="race" selected={task.type === "race"}>
                {t("Race to goal")}
              </option>
              <option value="time-trial" selected={task.type === "time-trial"}>
                {t("Time trial")}
              </option>
            </select>
          </div>
          <div>
            <label>{t("Type de goal")}</label>
            <select name="goalKind">
              <option value="cylinder" selected={task.turnpoints.at(-1)?.zone.kind === "cylinder"}>
                {t("Cylindre")}
              </option>
              <option value="goal-line" selected={task.turnpoints.at(-1)?.zone.kind === "goal-line"}>
                {t("Ligne (demi-cercle derrière)")}
              </option>
            </select>
          </div>
          <div>
            <label>{t("Portes de départ (heures locales)")}</label>
            <input type="text" name="startGates" placeholder="15:00, 15:15" value={task.startGates.map((g) => loc(g).replace(/:00$/, "")).join(", ")} />
          </div>
          <div>
            <label>{t("Deadline (heure locale)")}</label>
            <input type="text" name="deadline" placeholder="HH:MM" value={loc(task.deadline).replace(/:00$/, "")} />
          </div>
          <div>
            <label>{t("Tolérance des cylindres (%)")}</label>
            <input type="number" step="any" min="0" max="1" name="cylinderTolerance" placeholder={settings.gapProfile === "PWCA" ? t("vide : 0,1 % (PWCA)") : t("vide : 0 % + 5 m (S7F 2026)")} value={task.cylinderTolerance !== undefined ? String(+(task.cylinderTolerance * 100).toFixed(4)) : ""} />
          </div>
          <div>
            <label>{t("Elevated goal : hauteur au-dessus du goal (m)")}</label>
            <input type="number" step="1" min="0" max="1000" name="elevatedGoal" placeholder={t("vide : goal ordinaire (S7F : 300)")} value={task.elevatedGoal ? String(task.elevatedGoal) : ""} />
          </div>
          <div>
            <label>{t("Manche arrêtée : heure d'annonce (locale)")}</label>
            <input type="text" name="stop" placeholder="HH:MM" value={loc(task.stopAnnouncement)} />
          </div>
          <div>
            <label>{t("Manche arrêtée : finesse du bonus d'altitude")}</label>
            <input type="number" step="any" min="0" name="bonusGlideRatio" placeholder="2,5 (S7F)" value={task.bonusGlideRatio !== undefined ? String(task.bonusGlideRatio) : ""} />
          </div>
          <div>
            <label>{t("Leading Time Ratio (%)")}</label>
            <input
              type="number"
              step="any"
              min="0"
              max="26"
              name="leadingTimeRatio"
              placeholder={settings.gapProfile === "PWCA" ? "26,3158 (PWCA)" : "26 (S7F)"}
              value={task.leadingTimeRatio !== undefined ? String(+(task.leadingTimeRatio * 100).toFixed(4)) : ""}
            />
          </div>
          <div>
            <label>{t("Pilotes présents (sauf ABS)")}</label>
            <input type="number" step="1" min="0" name="pilotsPresent" placeholder={t("pilotes qui ont volé")} value={task.pilotsPresent ?? ""} />
          </div>
          <div>
            <label>{t("Fin des vols pour le leading")}</label>
            <select name="leadingEnd">
              {Object.entries(LEADING_ENDS).map(([k, l]) => (
                <option value={k} selected={(task.leadingEnd ?? "lastEss") === k}>
                  {t(l)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>{t("Formule du leading des pilotes posés")}</label>
            <select name="leadingFormula">
              {Object.entries(LEADING_FORMULAS).map(([k, l]) => (
                <option value={k} selected={(task.leadingFormula ?? "GAP2026") === k}>
                  {t(l)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>{t("Fin de manche pour le leading (locale)")}</label>
            <input type="text" name="taskEndTime" placeholder={t("fin des vols")} value={loc(task.taskEndTime)} />
          </div>
          <h3 style="grid-column:1/-1;margin:.5em 0 0">{t("Règles anciennes")}</h3>
          <div>
            <label>{t("Orientation du goal en ligne")}</label>
            <select name="goalLineOrientation">
              {Object.entries(GOAL_LINE_ORIENTATIONS).map(([k, l]) => (
                <option value={k} selected={(task.goalLineOrientation ?? "route") === k}>
                  {t(l)}
                </option>
              ))}
            </select>
          </div>
          <div style="align-self:end">
            <button>
              <Bi n="save" />
              {t("Enregistrer")}
            </button>
          </div>
        </form>
        <details class="mt">
          <summary>{t("Remplacer la définition de la manche (QR code corrigé)")}</summary>
          <form method="post" action={`/tasks/${tk.id}/definition`} enctype="multipart/form-data">
            <p class="small muted">
              {t("Balises, portes de départ et deadline sont remplacées ; les autres réglages de la manche et les traces sont gardés. Une seule des trois sources suffit.")}
            </p>
            <div class="grid">
              <div>
                <label>{t("Fichier XCTrack (.xctsk)")}</label>
                <input type="file" name="xctsk" accept=".xctsk,.json,.txt" />
              </div>
              <div>
                <label>{t("Image du QR code (PNG ou JPEG)")}</label>
                <input type="file" name="qr" accept="image/png,image/jpeg" />
              </div>
            </div>
            <label class="mt">{t("Ou texte du QR code (commence par XCTSK:)")}</label>
            <textarea name="text" placeholder="XCTSK:{...}"></textarea>
            <p class="mt">
              <button>
                <Bi n="upload" />
                {t("Remplacer")}
              </button>
            </p>
          </form>
        </details>
      </details>

      <div class="card" id="tracks">
        <h2><Ic n="pulse" c="green" />{t("Traces ({n})", { n: tracks.length })}</h2>
        <form method="post" action={`/tasks/${tk.id}/tracks`} enctype="multipart/form-data" class="row upload">
          <input type="file" name="files" accept=".igc,.zip" multiple required />
          <button>
            <Bi n="upload" />
            {t("Envoyer")}
          </button>
          <span class="small muted">
            {t(
              "Fichiers IGC ou archive .zip. Le pilote est reconnu au numéro du fichier ou, à défaut, au nom inscrit dans la trace ; une trace sans pilote reconnu est ajoutée à part, sans en écraser une autre. Une seconde trace pour un même pilote est gardée à côté de la première : le calcul retient la plus favorable au pilote. Pour remplacer une trace, utilisez « Remplacer » sur sa ligne.",
            )}
          </span>
        </form>
        {tracks.length && !registry.length ? (
          <p class="note mt">
            {t("Aucun pilote inscrit dans la compétition : les classements n'affichent que le nom des traces.")}{" "}
            <a href={pilotsUrl}>{t("Ajouter les pilotes (FSDB ou CSV)")}</a>
            {" "}
            {t("pour afficher nation, voile, sponsor… Les traces s'y rattachent par le numéro.")}
          </p>
        ) : null}
        {registry.length && unlinked.length ? (
          <div class="note mt">
            {unlinked.length === 1
              ? t("{n} trace n'est rattachée à aucun pilote inscrit : sa nation, son sponsor… n'apparaissent pas dans les classements.", { n: unlinked.length })
              : t("{n} traces ne sont rattachées à aucun pilote inscrit : leur nation, leur sponsor… n'apparaissent pas dans les classements.", { n: unlinked.length })}{" "}
            {t("Complétez les")} <a href={pilotsUrl}>{t("pilotes de la compétition")}</a>
            {t(", ou choisissez le pilote sur la ligne de la trace.")}
            <form method="post" action={`/tasks/${tk.id}/tracks/link`} class="mt">
              <button>
                <Bi n="refresh" />
                {t("Rattacher aux inscrits")}
              </button>{" "}
              <span class="small muted">{t("Par le numéro du fichier, le numéro de compétition ou le nom inscrit dans la trace.")}</span>
            </form>
          </div>
        ) : null}
        {tracks.length ? (
          <details class="mt" open={openTracks || unlinked.length > 0}>
            <summary>{t("Voir les traces")}</summary>
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("Pilote")}</th>
                    <th>{t("Nom")}</th>
                    <th>{t("Fichier")}</th>
                    <th>{t("Reçu")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((tr) => (
                    <tr>
                      <td>{tr.pilot_key}</td>
                      <td>
                        <a href={`/tasks/${tk.id}/pilots/${encodeURIComponent(tr.pilot_key)}`}>{reg.get(tr.pilot_key)?.name ?? tr.pilot_name ?? tr.pilot_key}</a>
                        {reg.has(tr.pilot_key) ? (
                          <div class="small muted">{[reg.get(tr.pilot_key)!.nation, reg.get(tr.pilot_key)!.sponsor].filter(Boolean).join(" · ")}</div>
                        ) : registry.length ? (
                          <span class="badge warn" title={t("Aucun pilote inscrit sous ce numéro dans la compétition.")}>
                            {t("non inscrit")}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <a class="muted" href={fileUrl(tr.sha256)}>
                          {tr.filename}
                        </a>
                        {versions.get(tr.pilot_key) ? <span class="badge">v{(versions.get(tr.pilot_key) ?? 0) + 1}</span> : null}
                        {(perPilot.get(tr.pilot_key) ?? 0) > 1 ? (
                          chosenTracks[tr.pilot_key] === tr.sha256 ? (
                            <span class="badge" title={t("Le pilote a plusieurs traces : celle-ci lui donne le plus de points.")}>{t("retenue")}</span>
                          ) : chosenTracks[tr.pilot_key] ? (
                            <span class="badge muted" title={t("Le pilote a plusieurs traces : une autre lui donne plus de points.")}>{t("non retenue")}</span>
                          ) : (
                            <span class="badge" title={t("Le pilote a plusieurs traces : le calcul retiendra la plus favorable.")}>{t("{n} traces", { n: perPilot.get(tr.pilot_key)! })}</span>
                          )
                        ) : null}
                        {tr.note ? <div class="small muted">{tr.note}</div> : null}
                      </td>
                      <td class="small muted">{when(tr.uploaded_at)}</td>
                      <td>
                        <details class="replace">
                          <summary>{t("Remplacer")}</summary>
                          <form method="post" action={`/tasks/${tk.id}/tracks/${tr.id}/replace`} enctype="multipart/form-data" class="upload">
                            <input type="file" name="file" accept=".igc,.zip" required />
                            <input type="text" name="note" placeholder={t("Raison (facultatif) : trace reçue après coup, autre instrument…")} maxlength={500} />
                            <button>
                              <Bi n="refresh" />
                              {t("Remplacer la trace")}
                            </button>
                          </form>
                        </details>
                        {registry.length ? (
                          <details class="replace" open={!reg.has(tr.pilot_key) && unlinked.length === 1}>
                            <summary>{reg.has(tr.pilot_key) ? t("Changer de pilote") : t("Rattacher")}</summary>
                            <form method="post" action={`/tasks/${tk.id}/tracks/${tr.id}/pilot`} class="upload">
                              <select name="pilot_key" required>
                                <option value="">{t("Pilote inscrit…")}</option>
                                {registry.map((p) => (
                                  <option value={p.pilot_key} selected={p.pilot_key === tr.pilot_key}>
                                    {p.pilot_key} · {p.name}
                                  </option>
                                ))}
                              </select>
                              <button>{t("Rattacher la trace")}</button>
                            </form>
                          </details>
                        ) : null}
                        <form method="post" action={`/tasks/${tk.id}/tracks/${tr.id}/delete`}>
                          <button class="link">{t("Retirer")}</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <form
              method="post"
              action={`/tasks/${tk.id}/tracks/delete-all`}
              class="mt"
              onsubmit={`return confirm(${JSON.stringify(t("Retirer les {n} traces de cette manche ? Elles restent dans les anciennes versions, mais le prochain calcul se fera sans elles.", { n: tracks.length }))})`}
            >
              <button class="link">{t("Retirer toutes les traces")}</button>
            </form>
          </details>
        ) : null}
        {history.length ? (
          <details class="mt">
            <summary>{t("Anciennes versions ({n})", { n: history.length })}</summary>
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("Pilote")}</th>
                    <th>{t("Fichier")}</th>
                    <th>{t("Reçu")}</th>
                    <th>{t("Fin")}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr>
                      <td>
                        {h.pilot_key} {h.pilot_name ? <span class="muted">{h.pilot_name}</span> : null}
                      </td>
                      <td>
                        <a class="muted" href={fileUrl(h.sha256)}>
                          {h.filename}
                        </a>{" "}
                        · <a href={`/tasks/${tk.id}/pilots/${encodeURIComponent(h.pilot_key)}?v=${h.sha256}`}>{t("voir")}</a>
                        {h.note ? <div class="small muted">{h.note}</div> : null}
                      </td>
                      <td class="small muted">
                        {when(h.uploaded_at)}
                        {h.uploaded_by_name ? ` · ${h.uploaded_by_name}` : ""}
                      </td>
                      <td class="small">
                        {h.ended_how === "replaced" ? t("Remplacée le {date}", { date: when(h.ended_at) }) : t("Retirée le {date}", { date: when(h.ended_at) })}
                        {h.ended_by_name ? ` · ${h.ended_by_name}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </div>

      <div class="card" id="run-card">
        <RunCard t={tk} run={run} running={running} settings={settings} tracks={tracks.length} stale={run !== null && lastChange > run.started_at} />
      </div>

      <details class="card fold" id="decisions">
        <summary>
          <h2><Ic n="gavel" c="pink" />{t("Décisions de l'organisateur ({n})", { n: decisions.length })}</h2>
        </summary>
        <p class="small muted">
          {t(
            "Bonus (aide à un pilote accidenté…), pénalités, goal accordé après réclamation, pilotes absents ou restés au sol. Elles s'appliquent au prochain calcul ; le motif apparaît dans les résultats.",
          )}
        </p>
        {decisions.length ? (
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Pilote")}</th>
                  <th>{t("Nom")}</th>
                  <th>{t("Décision")}</th>
                  <th>{t("Motif")}</th>
                  <th>{t("Saisie")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <tr>
                    <td>{d.pilot_key}</td>
                    <td>{d.pilot_name ?? tracks.find((x) => x.pilot_key === d.pilot_key)?.pilot_name ?? ""}</td>
                    <td>{decisionLabel(d.kind, d.value)}</td>
                    <td>{t(d.reason)}</td>
                    <td class="small muted">
                      {when(d.created_at)}
                      {d.created_by_name ? `, ${d.created_by_name}` : ""}
                    </td>
                    <td>
                      <form method="post" action={`/tasks/${tk.id}/decisions/${d.id}/delete`}>
                        <button class="link" onclick={`return confirm(${JSON.stringify(t("Supprimer cette décision ?"))})`}>
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
        <form method="post" action={`/tasks/${tk.id}/decisions`} class="grid mt">
          <div>
            <label>{t("Pilote (numéro)")}</label>
            <input type="text" name="pilot" list="pilot-keys" required />
            <datalist id="pilot-keys">
              {tracks.map((x) => (
                <option value={x.pilot_key}>{x.pilot_name ?? ""}</option>
              ))}
            </datalist>
          </div>
          <div>
            <label>{t("Nom (pilote sans trace)")}</label>
            <input type="text" name="name" />
          </div>
          <div>
            <label>{t("Décision")}</label>
            <select name="kind">
              {Object.entries(DECISION_KINDS).map(([k, v]) => (
                <option value={k}>{t(v.label)}</option>
              ))}
            </select>
          </div>
          <div>
            <label>{t("Valeur (points ou %)")}</label>
            <input type="number" step="any" min="0" name="value" placeholder={t("bonus, pénalité")} />
          </div>
          <div style="grid-column:span 2">
            <label>{t("Motif")}</label>
            <input type="text" name="reason" required placeholder={t("Aide à un pilote accidenté")} />
          </div>
          <div style="align-self:end">
            <button>
              <Bi n="plus" />
              {t("Ajouter")}
            </button>
          </div>
        </form>
      </details>

        </>
      ) : (
        <>
      <div class="card">
        <h2><Ic n="map" c="teal" />{t("Définition")}</h2>
        <div id="task-map" class="task-map" />
        <p class="small muted legend">
          <span style="color:#16a34a">● {t("départ")}</span> <span style="color:#2563eb">● {t("balise")}</span> <span style="color:#9333ea">● ESS</span>{" "}
          <span style="color:#dc2626">● goal</span> · {t("trait noir : route optimisée (distance de la manche), longueur de chaque branche")}
        </p>
        <p class="small">
          <a class="act" href={`/tasks/${tk.id}/qr.svg`} target="_blank" rel="noopener">
            <Bi n="qr" /> {t("QR code de la manche (XCTrack)")}
          </a>{" "}
          · <a href={`/tasks/${tk.id}/qr.txt`} target="_blank" rel="noopener">{t("texte du QR code")}</a>
        </p>
        <p class="small muted">
          {task.type === "race" ? t("Race to goal") : t("Time trial")} · {t("portes {gates}", { gates: task.startGates.map(loc).join(", ") || t("aucune") })} ·{" "}
          {t("deadline {time}", { time: loc(task.deadline) || t("aucune") })} · {t("heures locales ({tz})", { tz })}
        </p>
        <p class="small">
          {t("Manche")} <strong>{km(distances.task)} km</strong> · {t("décollage → ESS {d} km", { d: km(distances.launchToEss) })} ·{" "}
          {t("section de vitesse {d} km", { d: km(distances.speedSection) })}
        </p>
        <details class="fold" id="task-settings">
          <summary>{t("Balises")}</summary>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{t("Rôle")}</th>
                <th>{t("Balise")}</th>
                <th class="n">{t("Rayon")}</th>
                <th class="n">{t("Altitude")}</th>
              </tr>
            </thead>
            <tbody>
              {task.turnpoints.map((tp, i) => (
                <tr>
                  <td>{i + 1}</td>
                  <td>{ROLE[tp.role] ? t(ROLE[tp.role]!) : tp.role}</td>
                  <td>{tp.zone.waypoint.name}</td>
                  <td class="n">{tp.zone.kind === "cylinder" ? `${km(tp.zone.radius, tp.zone.radius % 1000 ? 1 : 0)} km` : t("ligne {n} m", { n: tp.zone.length })}</td>
                  <td class="n">{tp.zone.waypoint.altitude !== undefined ? `${tp.zone.waypoint.altitude} m` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </details>
      </div>

      <div class="card" id="results" data-swap>
        <h2><Ic n="trophy" c="amber" />{t("Résultats")}</h2>
        {results ? (
          <nav class="tabs">
            <a href={`/tasks/${tk.id}#results`} class={`swap${ranking || details ? "" : " on"}`}>
              {t("Général")}
            </a>
            {rankings.map((x) => (
              <a href={`/tasks/${tk.id}?r=${x.id}#results`} class={`swap${ranking?.id === x.id ? " on" : ""}`}>
                {t(x.name)}
              </a>
            ))}
            <a href={`/tasks/${tk.id}?view=details#results`} class={`swap tab-end${details ? " on" : ""}`}>
              <Bi n="calc" />
              {t("Détails de la manche")}
            </a>
          </nav>
        ) : null}
        {running ? (
          <div class="note">
            <span class="spin" /> {t("Calcul en cours.")} {canEdit ? <a href={`/tasks/${tk.id}/edit#run-card`}>{t("Suivre le calcul")}</a> : null}
          </div>
        ) : null}
        {results ? (
          <>
            {stale && !running && canEdit ? (
              <div class="note">
                {t("Des traces, réglages ou décisions ont changé depuis ce calcul : relancez-le pour mettre le classement à jour.")}{" "}
                <a href={`/tasks/${tk.id}/edit#run-card`}>{t("Relancer le calcul")}</a>
              </div>
            ) : null}
            <p class="small muted">
              <RunStatus run={done} tz={settings.timeZone} taskId={tk.id} inline />
            </p>
            {canEdit && results.pilots.some((p) => p.error) ? (
              <div class="note">
                {results.pilots.filter((p) => p.error).length === 1
                  ? t("1 trace en erreur ne figure pas dans ces résultats : prenez une décision (DNF, ABS, décollé sans trace…) ou remplacez la trace.")
                  : t("{n} traces en erreur ne figurent pas dans ces résultats : prenez une décision (DNF, ABS, décollé sans trace…) ou remplacez la trace.", {
                      n: results.pilots.filter((p) => p.error).length,
                    })}{" "}
                <a href={`/tasks/${tk.id}/edit#decisions`}>{t("Décisions de l'organisateur")}</a>
              </div>
            ) : null}
            {details ? (
              <TaskDetails r={results} settings={settings} />
            ) : (
              <TaskResults r={results} tz={settings.timeZone} goalAlt={goalAltitudeOf(task)} taskId={tk.id} speedSection={distances.speedSection} registry={registry} only={ranking?.members} rid={ranking?.id} />
            )}
          </>
        ) : running ? null : (
          <p class="muted">
            {t("Pas encore de résultats.")} {canEdit ? <a href={`/tasks/${tk.id}/edit`}>{t("Envoyer les traces et lancer le calcul")}</a> : null}
          </p>
        )}
      </div>
        </>
      )}

      {edit ? null : (
        <>
          <link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
          <script type="application/json" id="task-geometry" dangerouslySetInnerHTML={{ __html: geometry.replace(/</g, "\\u003c") }} />
          <script src="/vendor/leaflet/leaflet.js" />
          <script src="/static/basemaps.js" />
          <script src="/static/taskmap.js" />
          <script src="/static/competition.js" />
        </>
      )}
      <script src="/static/run.js" />
    </Layout>
  );
};
