import type { Child, FC } from "hono/jsx";
import { GAP_RULES, NOMINAL_GOAL, NOMINAL_LAUNCH, speedFraction, type DecisionKind, type LeadingWarning, type PilotResult, type Task, type TaskScoring } from "@pgscore/engine";
import type { PilotRow, RunRow, TaskRow } from "../db.js";
import { DECISION_KINDS } from "../decisions.js";
import { GAP_PROFILES, type CompetitionSettings } from "../settings.js";
import { duration, km, localTime } from "../time.js";
import { locale, N_, t } from "../i18n.js";
import { Ic, Bi } from "./layout.js";
import { identity, CsvLink, PrintButton, SportToggle, TotalHead, fr, pts, goalAltitudeOf } from "./parts.js";
import { toCsv } from "../text.js";

/** Bloc « Calcul » de l'onglet Éditer : bouton, avancement ou bilan. Rechargé seul par /static/run.js. */
export const RunCard: FC<{ t: TaskRow; run: RunRow | null; running: boolean; settings: CompetitionSettings; tracks: number; stale: boolean }> = ({
  t: tk,
  run,
  running,
  settings,
  tracks,
  stale,
}) => {
  const tz = settings.timeZone;
  const results = run?.status === "done" && run.results ? (JSON.parse(run.results) as TaskScoring) : null;
  return (
    <>
      <div class="row" style="justify-content:space-between">
        <h2><Ic n="calc" c="blue" />{t("Calcul")}</h2>
        <form method="post" action={`/tasks/${tk.id}/runs`} id="run-form">
          <button class="primary" disabled={running || !tracks}>
            {running ? <span class="spin" /> : <Bi n="play" />}
            {running ? t("Calcul en cours…") : t("Lancer le calcul")}
          </button>
        </form>
      </div>
      <RunStatus run={run} tz={tz} taskId={tk.id} />
      {stale && !running && results ? (
        <div class="note">{t("Des traces, réglages ou décisions ont changé depuis ce calcul : relancez-le pour mettre le classement à jour.")}</div>
      ) : null}
      {results ? <Results r={results} tz={tz} settings={settings} taskId={tk.id} goalAlt={goalAltitudeOf(JSON.parse(tk.task) as Task)} /> : null}
    </>
  );
};

/** Où en est le dernier calcul. inline : seulement la phrase du bilan (page des résultats). */
export const RunStatus: FC<{ run: RunRow | null; tz: string; taskId: number; inline?: boolean }> = ({ run, tz, taskId, inline }) => {
  if (!run) return <p class="muted">{t("Aucun calcul pour l'instant.")}</p>;
  const when = new Date(run.started_at).toLocaleString(locale(), { timeZone: tz, dateStyle: "short", timeStyle: "short" });
  if (run.status === "queued" || run.status === "running")
    // Rempli et mis à jour par /static/run.js.
    return (
      <div id="run-live" data-url={`/tasks/${taskId}/run.json`}>
        <p>
          <span class="spin" /> {t("Calcul en cours… {done} / {total} traces", { done: run.done, total: run.total })}
        </p>
      </div>
    );
  if (run.status === "error") return <div class="err">{t("Le calcul a échoué : {error}", { error: t(run.error ?? "") })}</div>;
  const secs = run.finished_at ? Math.round((run.finished_at - run.started_at) / 1000) : null;
  const text =
    secs !== null ? t("Calcul du {when}, {n} traces, en {secs} s.", { when, n: run.total, secs }) : t("Calcul du {when}, {n} traces.", { when, n: run.total });
  if (inline) return <>{text}</>;
  return (
    <p class="small muted">
      {text} <a href={`/tasks/${taskId}#results`}>{t("Voir les résultats")}</a>
    </p>
  );
};

const penalty = (p: PilotResult) =>
  p.airspacePenalty?.points !== undefined
    ? `−${t("{n} pts", { n: fr(p.airspacePenalty.points, 1) })}`
    : p.airspacePenalty?.fraction !== undefined
      ? `−${Math.round(p.airspacePenalty.fraction * 100)} %`
      : "";

/** Première zone non validée : de combien elle a été manquée (pour répondre au pilote). */
/** Étiquettes à côté du statut : bonus, pénalité (organisateur ou espace aérien), goal accordé. */
const StatusTags: FC<{ p: PilotResult }> = ({ p }) => {
  const d = p.decisions ?? [];
  const why = (kinds: string[]) =>
    [
      ...d.filter((x) => kinds.includes(x.kind)).map((x) => `${decisionLabel(x.kind, x.value)} : ${x.reason}`),
      ...(kinds.includes("penalty") && p.airspacePenalty ? [t("Espace aérien : {penalty}", { penalty: penalty(p) })] : []),
    ].join("\n");
  const bonus = d.some((x) => x.kind === "bonus");
  const pen = d.some((x) => x.kind === "penalty" || x.kind === "penalty-percent") || Boolean(p.airspacePenalty);
  return (
    <>
      {bonus ? (
        <>
          {" "}
          <span class="chip t-bonus" title={why(["bonus"])}>
            {t("bonus")}
          </span>
        </>
      ) : null}
      {pen ? (
        <>
          {" "}
          <span class="chip t-pen" title={why(["penalty", "penalty-percent"])}>
            {t("pénalité")}
          </span>
        </>
      ) : null}
      {d.some((x) => x.kind === "goal") ? (
        <>
          {" "}
          <span class="chip t-dec" title={why(["goal"])}>
            {t("accordé")}
          </span>
        </>
      ) : null}
    </>
  );
};

/** Décision lisible : « Bonus 799 pts », « Pénalité 10 % », « Goal accordé »… */
export function decisionLabel(kind: DecisionKind, value?: number | null): string {
  const k = DECISION_KINDS[kind];
  if (!k) return kind;
  const v = value ?? 0;
  if (kind === "bonus") return t("Bonus {n} pts", { n: v.toLocaleString(locale()) });
  if (kind === "penalty") return t("Pénalité {n} pts", { n: v.toLocaleString(locale()) });
  if (kind === "penalty-percent") return t("Pénalité {n} %", { n: v.toLocaleString(locale()) });
  return t(k.label);
}

function remark(p: PilotResult, tz: string): string {
  const decided = (p.decisions ?? []).map((d) => `${decisionLabel(d.kind, d.value)} : ${d.reason}`);
  const control = controlRemark(p, tz);
  return [...decided, control].filter(Boolean).join(" · ");
}

function controlRemark(p: PilotResult, tz: string): string {
  if (p.status === "GOAL" || p.status === "ABS" || p.status === "DNF" || p.error) return engineError(p.error);
  const a = (p.approaches ?? []).find((x) => !x.reached);
  // Au-delà de 500 m, c'est un posé normal, pas une zone frôlée.
  if (!a?.closest || Math.abs(a.closest.distance) > 500) return "";
  const d = a.closest.distance;
  const params = { name: a.name, d: Math.abs(d).toFixed(0), time: localTime(a.closest.time, tz) };
  if (a.role === "sss") return d >= 0 ? t("Départ manqué de {d} m (dehors) à {time}", params) : t("Départ manqué de {d} m (dedans) à {time}", params);
  return d >= 0 ? t("{name} manquée de {d} m (dehors) à {time}", params) : t("{name} manquée de {d} m (dedans) à {time}", params);
}

/** Messages d'erreur du moteur (en français) : traduits, le détail technique gardé tel quel. */
function engineError(e: string | null | undefined): string {
  if (!e) return "";
  const m = /^Trace illisible : (.*)$/s.exec(e);
  if (m) return t("Trace illisible : {detail}", { detail: m[1]! });
  return t(e);
}
// Textes venus du moteur ou de la base, traduits à l'affichage.
N_("Aucun point GPS valide dans la trace.");
N_("Pas de vol détecté dans la trace.");
N_("aucun point marqué");
N_("manche arrêtée de validité inférieure à 0,05");
N_("Féminin");
N_("Interrompu par un redémarrage du serveur.");

/** Alertes de qualité de trace pour le leading ; les anciens calculs les gardaient en texte. */
function leadingWarning(w: LeadingWarning | string): string {
  if (typeof w === "string") return w;
  if (w.kind === "sparse") return t("points espacés de {n} s en moyenne", { n: w.seconds });
  if (w.kind === "gap") return t("trou de {d} dans la trace", { d: duration(w.seconds) });
  return t("trace arrêtée avant l'atterrissage");
}

/** Validité de la manche et répartition des points (S7F 10 et 11). */
const GapSummary: FC<{ r: TaskScoring; settings: CompetitionSettings }> = ({ r, settings }) => {
  const g = r.gap;
  const v = g.validity;
  const winner = Math.max(0, ...r.pilots.map((p) => p.total ?? 0));
  return (
    <div class="gap">
      <div>
        <div class="muted small">{t("Validité de la manche")}</div>
        <div class="big">{fr(v.task, 4)}</div>
        <div class="small">
          {t("décollage {a} × distance {b} × temps {c}", { a: fr(v.launch, 3), b: fr(v.distance, 3), c: fr(v.time, 3) })}
          {v.stopped !== null ? ` × ${t("arrêt {v}", { v: fr(v.stopped, 3) })}` : ""}
        </div>
        <div class="small">
          <strong>{t("validité FTV {pct} %", { pct: fr(winner / 10, 1) })}</strong>{" "}
          {t("(vainqueur {pts} / 1000), celle du classement général", { pts: pts(winner) })}
        </div>
      </div>
      <div>
        <div class="muted small">{t("Points disponibles")}</div>
        <div class="big">{fr(g.available.distance + g.available.time + g.available.leading + g.available.arrival, 1)}</div>
        <div class="small">
          {t("distance {d} · temps {t} · leading {l}", { d: pts(g.available.distance), t: pts(g.available.time), l: pts(g.available.leading) })}
          {g.timePointsReduction ? ` ${t("(dont {pts} repris au temps, manche arrêtée)", { pts: pts(g.timePointsReduction) })}` : ""}
        </div>
      </div>
      <div>
        <div class="muted small">{t("Pilotes")}</div>
        <div class="big">{g.pilotsFlying}</div>
        <div class="small">
          {t("volants sur {present} présents · {ess} à l'ESS · {goal} au goal (ratio {ratio})", {
            present: g.pilotsPresent,
            ess: g.pilotsEss,
            goal: g.pilotsGoal,
            ratio: fr(g.goalRatio, 3),
          })}
        </div>
      </div>
      <div>
        <div class="muted small">{t("Formule")}</div>
        <div class="big">{t(GAP_PROFILES[settings.gapProfile]).split(" (")[0]}</div>
        <div class="small">
          {t("LTR {ltr} % · meilleur temps {time} · meilleure distance {d} km", {
            ltr: fr(g.leadingTimeRatio * 100, (g.leadingTimeRatio * 100) % 1 ? 2 : 0),
            time: duration(g.bestTime),
            d: km(g.bestDistance),
          })}
        </div>
      </div>
    </div>
  );
};

/** Une ligne d'explication : ce qui est calculé, comment, et la valeur obtenue. */
const Calc: FC<{ label: string; how?: Child; value: Child }> = ({ label, how, value }) => (
  <tr>
    <th>{label}</th>
    <td class="how">{how}</td>
    <td class="n val">{value}</td>
  </tr>
);

/** Onglet « Détails de la manche » : validité, répartition des points et calcul d'un pilote, expliqués avec les valeurs de la manche. */
export const TaskDetails: FC<{ r: TaskScoring; settings: CompetitionSettings }> = ({ r, settings }) => {
  const g = r.gap;
  if (!g) return <div class="note">{t("Ce calcul date d'avant les points GAP : relancez-le pour les obtenir.")}</div>;
  const v = g.validity;
  const rules = GAP_RULES[settings.gapProfile];
  const flying = r.pilots.filter((p) => !p.error && p.status !== "ABS" && p.status !== "DNF");
  const minD = settings.minimumDistance;
  const nomD = settings.nominalDistance;
  const lvr = g.pilotsPresent ? Math.min(1, g.pilotsFlying / (g.pilotsPresent * NOMINAL_LAUNCH)) : 0;
  const bestFlown = Math.max(0, ...flying.map((p) => p.flownDistance));
  const sum = flying.reduce((s, p) => s + Math.max(0, p.flownDistance - minD), 0);
  const area = ((NOMINAL_GOAL + 1) * (nomD - minD) + Math.max(0, NOMINAL_GOAL * (bestFlown - nomD))) / 2;
  const timeRatio = g.bestTime !== null ? g.bestTime / settings.nominalTime : bestFlown / nomD;
  const G = g.goalRatio;
  const { d, c: cc, b, a } = rules.distanceWeight;
  const dw = g.weights?.distance ?? d + cc * G + b * G ** 2 + a * G ** 3;
  const lw = g.weights?.leading ?? (G === 0 ? 1 - dw : (1 - dw) * g.leadingTimeRatio);
  const tw = g.weights?.time ?? 1 - dw - lw;
  const total = g.available.distance + g.available.time + g.available.leading;
  const winner = [...r.pilots].sort((x, y) => (y.total ?? 0) - (x.total ?? 0))[0];
  const lander = [...r.pilots].filter((p) => p.status === "DF" || p.status === "MIND").sort((x, y) => (y.total ?? 0) - (x.total ?? 0))[0];
  const share = (w: number) => fr(w * 100, 1);
  const lcFormula = "1 − ((LC − LCmin)² / LCmin)^(1/3)";
  const Example: FC<{ p: PilotResult; title: string }> = ({ p, title }) => {
    const pt = p.points;
    if (!pt) return null;
    const timeFrac = p.status === "GOAL" && p.speedSectionTime !== null && g.bestTime ? speedFraction(p.speedSectionTime, g.bestTime) : null;
    return (
      <>
        <h3>{title}</h3>
        <table class="calc">
          <tbody>
            <Calc
              label={t("Points distance")}
              how={t("{d} km / meilleure distance {best} km × {avail} points distance", {
                d: km(p.distance),
                best: km(g.bestDistance),
                avail: pts(g.available.distance),
              })}
              value={pts(pt.distance)}
            />
            <Calc
              label={t("Points temps")}
              how={
                timeFrac !== null
                  ? t("temps {time}, meilleur temps {best} : part de vitesse {frac} % × {avail} points temps", {
                      time: duration(p.speedSectionTime),
                      best: duration(g.bestTime),
                      frac: fr(timeFrac * 100, 1),
                      avail: pts(g.available.time),
                    }) + (g.timePointsReduction ? ` − ${pts(g.timePointsReduction)} (${t("manche arrêtée")})` : "")
                  : t("pas au goal : pas de points de temps")
              }
              value={pts(pt.time)}
            />
            <Calc
              label={t("Points leading")}
              how={
                p.leadingFactor !== null && p.leadingCoefficient !== null && r.lcMin !== null
                  ? t("LC {lc}, LC min {min} : facteur {f} × {avail} points leading", {
                      lc: fr(p.leadingCoefficient, 4),
                      min: fr(r.lcMin, 4),
                      f: fr(p.leadingFactor, 3),
                      avail: pts(g.available.leading),
                    })
                  : t("pas de coefficient de leading")
              }
              value={pts(pt.leading)}
            />
            {p.penaltyPoints ? <Calc label={t("Pénalité")} how={remark(p, settings.timeZone)} value={`−${pts(p.penaltyPoints)}`} /> : null}
            <Calc label={t("Total")} value={<strong>{pts(p.total)}</strong>} />
          </tbody>
        </table>
      </>
    );
  };
  return (
    <div class="details">
      <GapSummary r={r} settings={settings} />

      <h3>{t("1. Validité de la manche : {v}", { v: fr(v.task, 4) })}</h3>
      <p class="small muted">
        {t(
          "La validité dit à quel point la manche a été une vraie manche de compétition. Les 1000 points sont multipliés par elle : une manche courte, peu volée ou trop rapide vaut moins de 1000 points.",
        )}
      </p>
      <table class="calc">
        <tbody>
          <Calc
            label={t("Décollage")}
            how={t(
              "{flying} pilotes ont décollé sur {present} présents. Rapport {lvr} = volants / (présents × 0,96) ; validité = 0,028·x + 2,917·x² − 1,944·x³, au plus 1.",
              { flying: g.pilotsFlying, present: g.pilotsPresent, lvr: fr(lvr, 3) },
            )}
            value={fr(v.launch, 3)}
          />
          <Calc
            label={t("Distance")}
            how={t(
              "Somme des distances volées au-delà de la distance minimale ({min} km) : {sum} km pour {n} pilotes, comparée à ce que donnerait une manche nominale ({nom} km, 30 % des pilotes au goal) : {area} km par pilote. Validité = {sum} / ({n} × {area}), au plus 1.",
              { min: km(minD, 1), sum: km(sum, 1), n: flying.length, nom: km(nomD, 1), area: km(area, 1) },
            )}
            value={fr(v.distance, 3)}
          />
          <Calc
            label={t("Temps")}
            how={
              g.bestTime !== null
                ? t("Meilleur temps {best} pour un temps nominal de {nominal} : rapport {x}, au plus 1 ; validité = −0,271 + 2,912·x − 2,098·x² + 0,457·x³.", {
                    best: duration(g.bestTime),
                    nominal: duration(settings.nominalTime),
                    x: fr(Math.min(1, timeRatio), 3),
                  })
                : t("Personne à l'ESS : rapport meilleure distance / distance nominale = {x}, au plus 1 ; même formule que pour le temps.", {
                    x: fr(Math.min(1, timeRatio), 3),
                  })
            }
            value={fr(v.time, 3)}
          />
          {v.stopped !== null ? (
            <Calc
              label={t("Arrêt")}
              how={t("Manche arrêtée : validité d'arrêt selon l'écart des distances et le nombre de pilotes encore en vol à l'arrêt (S7F 13.4.3) ; 1 si un pilote a atteint l'ESS.")}
              value={fr(v.stopped, 3)}
            />
          ) : null}
          <Calc
            label={t("Validité de la manche")}
            how={v.stopped !== null ? t("décollage × distance × temps × arrêt") : t("décollage × distance × temps")}
            value={<strong>{fr(v.task, 4)}</strong>}
          />
        </tbody>
      </table>

      <h3>{t("2. Répartition des points : {total} points disponibles", { total: fr(total, 1) })}</h3>
      <p class="small muted">
        {t(
          "Les points disponibles (1000 × validité) sont partagés entre distance, temps et leading selon la part de pilotes au goal : plus il y a de pilotes au goal, plus la vitesse compte et moins la distance rapporte.",
        )}
      </p>
      <div class="split" aria-hidden="true">
        <span style={`width:${dw * 100}%;background:#2563eb`}>{t("distance")}</span>
        <span style={`width:${tw * 100}%;background:#16a34a`}>{tw > 0.08 ? t("temps") : ""}</span>
        <span style={`width:${lw * 100}%;background:#d97706`}>{lw > 0.08 ? "leading" : ""}</span>
      </div>
      <table class="calc">
        <tbody>
          <Calc
            label={t("Ratio de goal")}
            how={t("{goal} pilotes au goal / {flying} volants", { goal: g.pilotsGoal, flying: g.pilotsFlying })}
            value={fr(G, 3)}
          />
          <Calc
            label={t("Part distance")}
            how={`${fr(d, 3)} ${cc < 0 ? "−" : "+"} ${fr(Math.abs(cc), 3)}·G ${b < 0 ? "−" : "+"} ${fr(Math.abs(b), 3)}·G² ${a < 0 ? "−" : "+"} ${fr(Math.abs(a), 3)}·G³`}
            value={`${share(dw)} %`}
          />
          <Calc
            label={t("Part leading")}
            how={
              G === 0
                ? t("personne au goal : tout le reste va au leading")
                : t("(1 − part distance) × LTR {ltr} %", { ltr: fr(g.leadingTimeRatio * 100, g.leadingTimeRatio * 100 % 1 ? 2 : 0) })
            }
            value={`${share(lw)} %`}
          />
          <Calc label={t("Part temps")} how={t("le reste")} value={`${share(tw)} %`} />
          <Calc
            label={t("Points disponibles")}
            how={t("1000 × {v} × part : distance {d} · temps {t} · leading {l}", {
              v: fr(v.task, 4),
              d: pts(g.available.distance),
              t: pts(g.available.time),
              l: pts(g.available.leading),
            })}
            value={<strong>{fr(total, 1)}</strong>}
          />
          {g.timePointsReduction ? (
            <Calc
              label={t("Manche arrêtée")}
              how={t("{pts} points de temps retirés à chaque pilote au goal et reversés en distance (S7F 13.4.5).", { pts: pts(g.timePointsReduction) })}
              value=""
            />
          ) : null}
        </tbody>
      </table>

      <h3>{t("3. Comment un pilote marque ses points")}</h3>
      <ul class="small muted">
        <li>{t("Distance : sa distance divisée par la meilleure distance, multipliée par les points distance disponibles.")}</li>
        <li>
          {t("Temps (pilotes au goal seulement) : part de vitesse = 1 − ((temps − meilleur temps) / √meilleur temps)^(5/6), temps en heures. Le plus rapide a tous les points de temps.")}
        </li>
        <li>
          {t("Leading : le coefficient LC mesure le temps passé devant le groupe ; le plus petit LC a tous les points. Facteur = {formula}.", { formula: lcFormula })}
        </li>
      </ul>
      {winner ? <Example p={winner} title={t("Exemple : {name}, vainqueur", { name: winner.name })} /> : null}
      {lander ? <Example p={lander} title={t("Exemple : {name}, meilleur pilote posé avant le goal", { name: lander.name })} /> : null}

      <h3>{t("4. Données de la manche")}</h3>
      <table class="calc">
        <tbody>
          <Calc label={t("Formule de points")} value={t(GAP_PROFILES[settings.gapProfile])} />
          <Calc label={t("Distance nominale (km)")} value={km(nomD, 1)} />
          <Calc label={t("Distance minimale (km)")} value={km(minD, 1)} />
          <Calc label={t("Temps nominal (min)")} value={String(settings.nominalTime / 60)} />
          <Calc label={t("Distance de la manche")} value={`${km(r.distances.task)} km`} />
          <Calc label={t("Pilotes présents / volants / ESS / goal")} value={`${g.pilotsPresent} / ${g.pilotsFlying} / ${g.pilotsEss} / ${g.pilotsGoal}`} />
          <Calc label={t("Meilleure distance")} value={`${km(g.bestDistance)} km`} />
          <Calc label={t("Meilleur temps")} value={duration(g.bestTime) || "–"} />
          <Calc label={t("LC min")} value={r.lcMin !== null ? fr(r.lcMin, 4) : "–"} />
          <Calc label="LTR" value={`${fr(g.leadingTimeRatio * 100, 4)} %`} />
        </tbody>
      </table>
    </div>
  );
};

/** Hauteur de passage au-dessus du goal publié, « 225 m ». */
const goalHeight = (p: PilotResult, goalAlt: number) => (p.goalAltitude != null ? `${Math.round(p.goalAltitude - goalAlt)} m` : "");

export const TaskResults: FC<{
  r: TaskScoring;
  tz: string;
  goalAlt: number;
  taskId: number;
  speedSection: number;
  registry: PilotRow[];
  only?: Set<string>;
  rid?: number;
}> = ({ r, tz, goalAlt, taskId, speedSection, registry, only, rid }) => {
  const shown = only ? r.pilots.filter((p) => only.has(p.id)) : r.pilots;
  const withPen = shown.some((p) => p.penaltyPoints);
  const elevated = shown.some((p) => p.goalAltitudeFactor !== undefined);
  const id = identity(registry, shown.map((p) => p.id));
  if (!r.gap) return <div class="note">{t("Ce calcul date d'avant les points GAP : relancez-le pour les obtenir.")}</div>;
  if (only && !shown.length) return <p class="muted">{t("Aucun pilote de ce classement dans les résultats de la manche.")}</p>;
  return (
    <>
      <SportToggle csv={`/tasks/${taskId}/results.csv${rid ? `?r=${rid}` : ""}`} />
      <div class="scroll">
        <table class="rk sport-hidden">
          <thead>
            <tr>
              <th class="n">#</th>
              <th class="n">{t("N°")}</th>
              <th>{t("Nom")}</th>
              <id.Head />
              <th class="sp">SS</th>
              <th class="sp">ES</th>
              <th class="n sp">{t("Temps")}</th>
              <th class="n sp">{t("Vitesse (km/h)")}</th>
              <th class="n sp">{t("Distance (km)")}</th>
              {elevated ? <th class="n sp">{t("Alt. goal")}</th> : null}
              <th class="n sp">{t("Pts distance")}</th>
              <th class="n sp">{t("Pts leading")}</th>
              <th class="n sp">{t("Pts temps")}</th>
              {elevated ? <th class="n sp">{t("Elevated goal")}</th> : null}
              {withPen ? <th class="n sp">{t("Pénalité")}</th> : null}
              <TotalHead />
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => {
              const absent = p.status === "ABS" || p.status === "DNF";
              const timed = (p.status === "GOAL" || p.status === "ESS") && p.speedSectionTime;
              return (
                <tr>
                  <td class="n">{i + 1}</td>
                  <td class="n muted">{p.id}</td>
                  <td>
                    {p.fixes ? <a href={`/tasks/${taskId}/pilots/${encodeURIComponent(p.id)}`}>{id.nameOf(p.id, p.name)}</a> : id.nameOf(p.id, p.name)}
                    <StatusTags p={p} />
                  </td>
                  <id.Cells k={p.id} />
                  <td class="sp">{absent ? "" : localTime(p.startTime, tz)}</td>
                  <td class="sp">{timed ? localTime(p.essTime, tz) : ""}</td>
                  <td class="n sp">{timed ? duration(p.speedSectionTime) : ""}</td>
                  <td class="n sp">{timed ? fr((speedSection / p.speedSectionTime!) * 3.6, 1) : ""}</td>
                  <td class="n sp">{absent ? <span class="chip">{p.status}</span> : p.error ? <span class="chip s-ERREUR">{t("Erreur")}</span> : km(p.distance)}</td>
                  {elevated ? <td class="n sp">{p.status === "GOAL" ? goalHeight(p, goalAlt) : ""}</td> : null}
                  <td class="n sp">{pts(p.points?.distance)}</td>
                  <td class="n sp">{pts(p.points?.leading)}</td>
                  <td class="n sp">{pts(p.points?.time)}</td>
                  {elevated ? <td class="n sp pen">{p.goalAltitudeLoss ? `−${pts(p.goalAltitudeLoss)}` : ""}</td> : null}
                  {withPen ? <td class="n sp pen">{p.penaltyPoints ? `${p.penaltyPoints > 0 ? "−" : "+"}${pts(Math.abs(p.penaltyPoints))}` : ""}</td> : null}
                  <td class="n">
                    <strong>{pts(p.total)}</strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SportToggle />
      <p class="small muted mt">
        {t("Heures locales ; vitesse sur la section de vitesse ({d} km).", { d: km(speedSection) })}{" "}
        <span class="acts">
          <CsvLink href={`/tasks/${taskId}/results.csv${rid ? `?r=${rid}` : ""}`} />
          <PrintButton />
        </span>
      </p>
    </>
  );
};

const Results: FC<{ r: TaskScoring; tz: string; settings: CompetitionSettings; taskId: number; goalAlt: number; only?: Set<string>; rid?: number }> = ({
  r,
  tz,
  settings,
  taskId,
  goalAlt,
  only,
  rid,
}) => {
  // Classement extrait : seulement ses pilotes, rang recalculé ; les points restent ceux de la manche.
  const shown = only ? r.pilots.filter((p) => only.has(p.id)) : r.pilots;
  const stopped = r.pilots.some((p) => p.stop);
  const elevated = r.pilots.some((p) => p.goalAltitudeFactor !== undefined);
  const counts = (s: string) => r.pilots.filter((p) => p.status === s).length;
  // Calcul fait avant l'arrivée des points GAP : il faut le relancer.
  const withPoints = Boolean(r.gap);
  const leadWarn = r.pilots.filter((p) => p.leadingWarnings?.length).length;
  return (
    <>
      {withPoints ? null : <div class="note">{t("Ce calcul date d'avant les points GAP : relancez-le pour les obtenir.")}</div>}
      <p class="small">
        {t("{goal} au goal · {ess} à l'ESS sans goal · {df} posés · {mind} à la distance minimale", {
          goal: counts("GOAL"),
          ess: counts("ESS"),
          df: counts("DF"),
          mind: counts("MIND"),
        })}
        {counts("ERREUR") ? ` · ${t("{n} traces en erreur", { n: counts("ERREUR") })}` : ""}
        {counts("DNF") ? ` · ${t("{n} restés au sol", { n: counts("DNF") })}` : ""}
        {counts("ABS") ? ` · ${t("{n} absents", { n: counts("ABS") })}` : ""}
        {leadWarn ? (
          <>
            {" "}
            · <span class="lead-warn">⚠</span>{" "}
            {leadWarn > 1
              ? t("{n} traces au leading peut-être faussé (trou, points espacés ou arrêt avant l'atterrissage : survolez l'icône)", { n: leadWarn })
              : t("{n} trace au leading peut-être faussé (trou, points espacés ou arrêt avant l'atterrissage : survolez l'icône)", { n: leadWarn })}
          </>
        ) : null}{" "}
        · {t(GAP_PROFILES[settings.gapProfile])} ·{" "}
        <CsvLink href={`/tasks/${taskId}/results.csv${rid ? `?r=${rid}` : ""}`} />
      </p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="n">#</th>
              <th>{t("Pilote")}</th>
              <th>{t("Nom")}</th>
              <th>{t("Statut")}</th>
              {withPoints ? <th class="n">{t("Total")}</th> : null}
              <th>{t("Départ")}</th>
              <th>ESS</th>
              <th class="n">{t("Temps")}</th>
              <th class="n">{t("Distance")}</th>
              {stopped ? <th class="n">{t("Alt. à l'arrêt")}</th> : null}
              <th class="n">LC</th>
              {withPoints ? (
                <>
                  {elevated ? <th class="n">{t("Alt. goal")}</th> : null}
                  <th class="n">{t("Pts distance")}</th>
                  <th class="n">{t("Pts temps")}</th>
                  <th class="n">{t("Pts leading")}</th>
                {elevated ? <th class="n">{t("Elevated goal")}</th> : null}
                  <th class="n">{t("Pénalité")}</th>
                </>
              ) : (
                <th class="n">{t("Leading")}</th>
              )}
              <th>{t("Espace aérien")}</th>
              <th>{t("Remarque")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => (
              <tr>
                <td class="n">{i + 1}</td>
                <td>{p.id}</td>
                <td>{p.fixes ? <a href={`/tasks/${taskId}/pilots/${encodeURIComponent(p.id)}`}>{p.name}</a> : p.name}</td>
                <td>
                  <span class={`chip s-${p.status}`} title={engineError(p.error)}>
                    {p.status}
                  </span>
                  <StatusTags p={p} />
                </td>
                {withPoints ? (
                  <td class="n">
                    <strong>{pts(p.total)}</strong>
                  </td>
                ) : null}
                <td>{localTime(p.startTime, tz)}</td>
                <td>{localTime(p.essTime, tz)}</td>
                <td class="n">{duration(p.speedSectionTime)}</td>
                <td class="n">{km(p.distance)} km</td>
                {stopped ? <td class="n">{p.stop?.flying ? `${Math.round(p.stop.altitudeAboveGoal)} m` : ""}</td> : null}
                <td class="n">
                  {p.leadingWarnings?.length ? (
                    <span class="lead-warn" title={t("Leading peut-être faussé : {why}", { why: p.leadingWarnings.map(leadingWarning).join(", ") })}>
                      ⚠
                    </span>
                  ) : null}
                  {p.leadingCoefficient !== null ? p.leadingCoefficient.toFixed(4) : ""}
                </td>
                {withPoints ? (
                  <>
                    {elevated ? (
                      <td class="n" title={p.goalAltitudeFactor !== undefined && p.goalAltitudeFactor < 1 ? t("Points de temps × {f} (elevated goal passé trop bas)", { f: p.goalAltitudeFactor.toFixed(3) }) : undefined}>
                        {goalHeight(p, goalAlt)}
                      </td>
                    ) : null}
                    <td class="n">{pts(p.points?.distance)}</td>
                    <td class="n">{pts(p.points?.time)}</td>
                    <td class="n">{pts(p.points?.leading)}</td>
                  {elevated ? (
                    <td class="n">{p.goalAltitudeLoss ? `−${pts(p.goalAltitudeLoss)}` : ""}</td>
                  ) : null}
                    <td class="n pen">{p.penaltyPoints ? `${p.penaltyPoints > 0 ? "−" : "+"}${pts(Math.abs(p.penaltyPoints))}` : ""}</td>
                  </>
                ) : (
                  <td class="n">{p.leadingFactor !== null ? p.leadingFactor.toFixed(3) : ""}</td>
                )}
                <td class="pen" title={p.airspace.map((a) => `${a.name} : ${a.depth.toFixed(0)} m`).join("\n")}>
                  {p.airspace.length ? `${p.airspace[0]!.name}${p.airspace.length > 1 ? ` +${p.airspace.length - 1}` : ""}, ${Math.max(...p.airspace.map((a) => a.depth)).toFixed(0)} m, ${penalty(p)}` : ""}
                </td>
                <td class="small">{remark(p, tz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {only && !shown.length ? <p class="muted">{t("Aucun pilote de ce classement dans les résultats de la manche.")}</p> : null}
      {shown.some((p) => p.error) ? (
        <ul class="small">
          {shown
            .filter((p) => p.error)
            .map((p) => (
              <li>
                {p.id} : {engineError(p.error)}
              </li>
            ))}
        </ul>
      ) : null}
    </>
  );
};

export function resultsCsv(r: TaskScoring, tz: string, goalAlt = 0): string {
  const head = [
    "rang", "pilote", "nom", "statut", "depart", "ess", "temps_s", "distance_km", "alt_arret_m", "lc", "leading",
    "pts_distance", "pts_temps", "pts_leading", "penalite_pts", "total", "espace_aerien", "profondeur_m", "penalite", "decisions", "alerte_leading",
    "hauteur_goal_m_agl", "facteur_alt_goal", "reduction_pts_temps",
  ];
  const rows = r.pilots.map((p, i) => [
    i + 1,
    p.id,
    p.name,
    p.status,
    localTime(p.startTime, tz),
    localTime(p.essTime, tz),
    p.speedSectionTime ?? "",
    (p.distance / 1000).toFixed(3),
    p.stop?.flying ? Math.round(p.stop.altitudeAboveGoal) : "",
    p.leadingCoefficient?.toFixed(5) ?? "",
    p.leadingFactor?.toFixed(4) ?? "",
    p.points?.distance.toFixed(1) ?? "",
    p.points?.time.toFixed(1) ?? "",
    p.points?.leading.toFixed(1) ?? "",
    p.penaltyPoints ? p.penaltyPoints.toFixed(1) : "",
    p.total?.toFixed(1) ?? "",
    p.airspace.map((a) => a.name).join(" | "),
    p.airspace.length ? Math.max(...p.airspace.map((a) => a.depth)).toFixed(1) : "",
    penalty(p),
    (p.decisions ?? []).map((d) => `${decisionLabel(d.kind, d.value)} : ${d.reason}`).join(" | "),
    (p.leadingWarnings ?? []).map(leadingWarning).join(" | "),
    p.goalAltitude != null ? Math.round(p.goalAltitude - goalAlt) : "",
    p.goalAltitudeFactor !== undefined ? p.goalAltitudeFactor.toFixed(4) : "",
    p.goalAltitudeLoss ? p.goalAltitudeLoss.toFixed(1) : "",
  ]);
  return toCsv([head, ...rows]);
}
