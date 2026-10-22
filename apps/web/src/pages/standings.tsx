import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { type Task } from "@pgscore/engine";
import type { CompetitionRow, PilotRow } from "../db.js";
import type { Standings } from "../standings.js";
import { t } from "../i18n.js";
import { describeRule, RULE_FIELDS, RULE_OPS, type Ranking } from "../rankings.js";
import { Bi, ErrorBox } from "./layout.js";
import { identity, CsvLink, PrintButton, SportToggle, TotalHead, fr, pts, goalAltitudeOf } from "./parts.js";
import { TaskResults } from "./results.js";

/** Ce qui compte au classement général, en une ligne. */
const StandingsInfo: FC<{ s: Standings }> = ({ s }) => {
  const notOfficial = s.tasks.filter((x) => !x.official).map((x) => x.t.number);
  const notCalculated = s.tasks.filter((x) => x.official && x.calculatedAt === null).map((x) => x.t.number);
  const stale = s.ranked.filter((x) => x.stale).map((x) => x.t.number);
  const list = (n: number[]) => n.map((x) => `M${x}`).join(", ");
  return (
    <>
      {notOfficial.length || notCalculated.length ? (
        <p class="small muted">
          {notOfficial.length ? `${t("Pas encore officielles, donc non comptées : {list}.", { list: list(notOfficial) })} ` : ""}
          {notCalculated.length ? t("Officielles mais pas encore calculées : {list}.", { list: list(notCalculated) }) : ""}
        </p>
      ) : null}
      {stale.length ? (
        <div class="note">{t("Des changements ne sont pas encore calculés pour {list} : relancez le calcul de ces manches.", { list: list(stale) })}</div>
      ) : null}

    </>
  );
};

const FtvCell: FC<{ ts: { score: number; fraction: number; counted: number } | undefined; included: boolean }> = ({ ts, included }) => {
  if (!ts) return <td class="n sp ftv-out">{included ? "0,0" : ""}</td>;
  if (!included) return <td class="n sp ftv-out">{pts(ts.score)}</td>;
  if (ts.fraction >= 1) return <td class="n sp">{pts(ts.score)}</td>;
  if (ts.fraction <= 0) return <td class="n sp ftv-out" title={t("Non retenue (FTV)")}>
        <s>{pts(ts.score)}</s>
      </td>;
  return (
    <td class="n sp" title={t("Retenue à {pct} % (FTV)", { pct: fr(ts.fraction * 100, 1) })}>
      <span class="ftv-part">{pts(ts.counted)}</span>
      <s class="ftv-raw">{pts(ts.score)}</s>
    </td>
  );
};

export const StandingsTable: FC<{ c: CompetitionRow; s: Standings; limit?: number; rid?: number; registry?: PilotRow[] }> = ({ c, s, limit, rid, registry = [] }) => {
  const r = s.ranking;
  const v = viewOf(s);
  const q = boardQs({ r: rid, ...v });
  if (!s.ranked.length)
    return (
      <>
        <p class="muted">
          {s.tasks.length
            ? t("Aucune manche officielle calculée : cochez « officielle » dans la liste des manches pour qu'une manche compte.")
            : t("Pas encore de manche.")}
        </p>
      </>
    );
  const pilots = limit ? r.pilots.slice(0, limit) : r.pilots;
  if (rid && !pilots.length) return <p class="muted">{t("Aucun pilote classé dans ce classement.")}</p>;
  const info = new Map(r.tasks.map((x) => [x.key, x]));
  const id = identity(registry, pilots.map((p) => p.pilot));
  return (
    <>
      <StandingsInfo s={s} />
      <SportToggle csv={`/competitions/${c.id}/standings.csv${q}`} />
      <div class="scroll">
        <table class="rk sport-hidden">
          <thead>
            <tr>
              <th class="n">#</th>
              <th class="n">{t("N°")}</th>
              <th>{t("Nom")}</th>
              <id.Head />
              {s.ranked.map((x) => {
                const ti = info.get(String(x.t.id))!;
                return (
                  <th
                    class="n sp"
                    title={
                      ti.excluded
                        ? t("Non comptée : {why}", { why: t(ti.excluded) })
                        : t("Validité FTV = points du vainqueur / 1000. Validité GAP de la manche {v}, {points} points disponibles.", {
                            v: fr(x.validity ?? 0, 3),
                            points: fr(x.available ?? 0, 1),
                          })
                    }
                  >
                    <a href={`/tasks/${x.t.id}`}>{t("M{n}", { n: x.t.number })}</a>
                    <span class="sub">{ti.included ? t("val. {pct} %", { pct: fr(ti.validity * 100, 1) }) : t("non comptée")}</span>
                  </th>
                );
              })}
              <TotalHead />
            </tr>
          </thead>
          <tbody>
            {pilots.map((p) => (
              <tr>
                <td class="n">{p.rank}</td>
                <td class="n muted">{p.pilot}</td>
                <td>{p.name}</td>
                <id.Cells k={p.pilot} />
                {s.ranked.map((x) => (
                  <FtvCell ts={p.tasks[String(x.t.id)]} included={info.get(String(x.t.id))!.included} />
                ))}
                <td class="n">
                  <strong>{pts(p.total)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SportToggle />
      <p class="small mt">
        {limit && r.pilots.length > limit ? (
          <>
            <a class="swap" href={boardUrl(c, { r: rid, all: true, ...v })}>
              {t("Voir les {n} pilotes", { n: r.pilots.length })}
            </a>{" "}
            ·{" "}
          </>
        ) : null}
        <span class="acts">
          <CsvLink href={`/competitions/${c.id}/standings.csv${q}`} />
          <PrintButton />
        </span>
        {r.ftvFactor > 0
          ? ` ${t("en gras, la part retenue d'une manche comptée en partie ; barré, le score de la manche non retenu")}`
          : ""}
      </p>
    </>
  );
};

/** Onglets des classements : général, puis les classements extraits. Ils restent sur la page de la compétition. */
/** Suppression d'un classement extrait (jamais le général), après confirmation. */
const DeleteRanking: FC<{ c: CompetitionRow; id: number; name: string; cls?: string; big?: boolean }> = ({ c, id, name, cls, big }) => (
  <form
    method="post"
    action={`/competitions/${c.id}/rankings/${id}/delete`}
    class={cls}
    data-confirm={t("Supprimer le classement « {name} » ? Le classement général n'est pas touché.", { name: t(name) })}
  >
    <button class={big ? "danger" : "link"} title={t("Supprimer ce classement")}>
      <Bi n="trash" />
      {t("Supprimer ce classement")}
    </button>
  </form>
);

const RankingTabs: FC<{
  c: CompetitionRow;
  rankings: Array<{ id: number; name: string; count?: number }>;
  current: number | null;
  create?: boolean;
  canEdit?: boolean;
  keep?: BoardView;
}> = ({ c, rankings, current, create, canEdit, keep = {} }) => (
  <nav class="tabs">
    <a href={boardUrl(c, keep)} class={`swap${current === null && !create ? " on" : ""}`}>
      {t("Général")}
    </a>
    {rankings.map((r) => (
      <a href={boardUrl(c, { r: r.id, ...keep })} class={`swap${current === r.id ? " on" : ""}`}>
        {t(r.name)}
      </a>
    ))}
    {canEdit ? (
      <a href={boardUrl(c, { create: true })} class={`swap${create ? " on" : ""}`}>
        + {t("Nouveau classement")}
      </a>
    ) : null}
    {canEdit && current !== null && !create ? (
      <DeleteRanking c={c} id={current} name={rankings.find((r) => r.id === current)?.name ?? ""} cls="tab-end no-print" />
    ) : null}
  </nav>
);

/** Règle d'un classement : nom et jusqu'à quatre conditions. */
const RankingForm: FC<{ c: CompetitionRow; r: Ranking | null }> = ({ c, r }) => {
  const conds = r?.rule.conditions ?? [];
  return (
    <form method="post" action={r ? `/competitions/${c.id}/rankings/${r.row.id}` : `/competitions/${c.id}/rankings`}>
      <div class="grid">
        <div>
          <label>{t("Nom du classement")}</label>
          <input type="text" name="name" value={r?.row.name ?? ""} placeholder={t("Serial, Lightweight, Sport…")} required />
        </div>
      </div>
      <p class="small muted mt">
        {t(
          "Pilotes retenus : ceux qui vérifient toutes les conditions remplies (données du bloc Pilotes). Plusieurs valeurs séparées par des virgules : « EN-C, EN-D ». Sans condition, le classement ne contient que les pilotes ajoutés à la main.",
        )}
      </p>
      {[1, 2, 3, 4].map((i) => {
        const k = conds[i - 1];
        return (
          <div class="row cond">
            <select name={`field${i}`}>
              <option value="">—</option>
              {Object.entries(RULE_FIELDS).map(([f, label]) => (
                <option value={f} selected={k?.field === f}>
                  {t(label)}
                </option>
              ))}
            </select>
            <select name={`op${i}`}>
              {Object.entries(RULE_OPS).map(([o, label]) => (
                <option value={o} selected={(k?.op ?? "in") === o}>
                  {t(label)}
                </option>
              ))}
            </select>
            <input type="text" name={`value${i}`} value={k?.value ?? ""} placeholder={i === 1 ? "F" : ""} />
          </div>
        );
      })}
      <p class="mt">
        <button class="primary">
          <Bi n={r ? "save" : "plus"} />
          {r ? t("Enregistrer la règle") : t("Créer le classement")}
        </button>
      </p>
    </form>
  );
};

/** Ajouts et retraits à la main dans un classement extrait. */
const RankingPilots: FC<{ c: CompetitionRow; r: Ranking; pilots: PilotRow[] }> = ({ c, r, pilots }) => {
  const names = new Map(pilots.map((p) => [p.pilot_key, p.name]));
  const action = `/competitions/${c.id}/rankings/${r.row.id}/pilots`;
  const manual = [...r.overrides].sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]));
  return (
    <>
      <div class="row">
        <form method="post" action={action} class="row">
          <input type="text" name="pilot" placeholder={t("N° du pilote")} class="in-s" required style="width:120px" />
          <button name="how" value="include">
            <Bi n="userPlus" />
            {t("Ajouter au classement")}
          </button>
          <button name="how" value="exclude">
            <Bi n="userMinus" />
            {t("Retirer du classement")}
          </button>
        </form>
      </div>
      {manual.length ? (
        <ul class="list">
          {manual.map(([key, inc]) => (
            <li>
              <span class={`chip ${inc ? "t-bonus" : "t-pen"}`}>{inc ? t("ajouté") : t("retiré")}</span>
              <span>
                {key} {names.get(key) ?? ""}
              </span>
              <form method="post" action={action} style="margin-left:auto">
                <input type="hidden" name="pilot" value={key} />
                <button class="link" name="how" value="reset">
                  {t("revenir à la règle")}
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p class="small muted">{t("Aucun ajout ni retrait à la main.")}</p>
      )}
    </>
  );
};

/** Classement affiché sur la page de la compétition : général ou extrait, création d'un classement. */
export interface Board {
  s: Standings;
  pilots: PilotRow[];
  rankings: Array<{ r: Ranking; count: number }>;
  current: Ranking | null;
  /** Pilotes du classement choisi (féminin…), pour filtrer le détail d'une manche. */
  members?: Set<string>;
  create: boolean;
  all: boolean;
  /** Créateur ou administrateur : création et réglage des classements, officialisation des manches. */
  canEdit: boolean;
  error?: string | null;
  notice?: string | null;
}

/** Manche choisie dans le classement : id de la manche, seule ou en cumul jusqu'à elle. */
type BoardView = { m?: number; cum?: boolean };

const viewOf = (s: Standings): BoardView => (s.view ? { m: s.view.task.t.id, cum: s.view.cumulative } : {});

/** Paramètres d'une vue du classement (« ?r=…&m=… »), vide pour le général. */
const boardQs = (q: { r?: number | null; all?: boolean; create?: boolean } & BoardView = {}) => {
  const p = new URLSearchParams();
  if (q.r) p.set("r", String(q.r));
  if (q.m) p.set("m", String(q.m));
  if (q.m && q.cum) p.set("cum", "1");
  if (q.all) p.set("all", "1");
  if (q.create) p.set("new", "1");
  const qs = p.toString();
  return qs ? `?${qs}` : "";
};

/** Adresse d'une vue du classement, sur la page de la compétition. */
export const boardUrl = (c: CompetitionRow, q: { r?: number | null; all?: boolean; create?: boolean } & BoardView = {}) =>
  `/competitions/${c.id}${boardQs(q)}#standings`;

/**
 * Onglets des manches, sous ceux des classements : toutes les manches (le général), ou une manche,
 * seule ou en cumul jusqu'à elle. Le classement choisi (féminin, sponsors…) reste appliqué.
 */
const TaskTabs: FC<{ c: CompetitionRow; s: Standings; rid?: number }> = ({ c, s, rid }) => {
  if (s.official.length < 2) return null;
  const v = s.view;
  const cum = v?.cumulative ?? false;
  return (
    <nav class="mtabs" aria-label={t("Manches")}>
      <a href={boardUrl(c, { r: rid })} class={`swap${v ? "" : " on"}`}>
        {t("Toutes les manches")}
      </a>
      {s.official.map((x) => (
        <a href={boardUrl(c, { r: rid, m: x.t.id, cum })} class={`swap${v?.task.t.id === x.t.id ? " on" : ""}`}>
          {t("M{n}", { n: x.t.number })}
        </a>
      ))}
      {v ? (
        <>
          <span class="sep" />
          <a href={boardUrl(c, { r: rid, m: v.task.t.id })} class={`swap${cum ? "" : " on"}`}>
            {t("Manche seule")}
          </a>
          <a href={boardUrl(c, { r: rid, m: v.task.t.id, cum: true })} class={`swap${cum ? " on" : ""}`}>
            {t("Cumul après M{n}", { n: v.task.t.number })}
          </a>
          <a class="mlink" href={`/tasks/${v.task.t.id}${rid ? `?r=${rid}` : ""}#results`}>
            {t("Détail de la manche")} →
          </a>
        </>
      ) : null}
    </nav>
  );
};

export const StandingsBoard: FC<{ c: CompetitionRow; b: Board }> = ({ c, b }) => {
  const { s, pilots, rankings, current, create } = b;
  return (
    <>
      <RankingTabs
        c={c}
        rankings={rankings.map((x) => ({ id: x.r.row.id, name: x.r.row.name, count: x.count }))}
        current={current?.row.id ?? null}
        create={create}
        canEdit={b.canEdit}
        keep={create ? {} : viewOf(s)}
      />
      {create ? null : <TaskTabs c={c} s={s} rid={current?.row.id} />}
      <ErrorBox message={b.error} />
      {b.notice ? <div class="note">{b.notice}</div> : null}
      {create ? (
        <RankingForm c={c} r={null} />
      ) : (
        <>
          {current && !pilots.length && b.canEdit ? <p class="small muted">{t("Aucun pilote inscrit : importez la liste dans le bloc Pilotes de la compétition.")}</p> : null}
          {s.view?.detail ? (
            // Manche seule : le tableau détaillé de la page de la manche (distances, temps, points).
            <TaskResults
              r={s.view.detail.results}
              tz={s.view.detail.timeZone}
              goalAlt={goalAltitudeOf(JSON.parse(s.view.task.t.task) as Task)}
              taskId={s.view.task.t.id}
              speedSection={s.view.detail.speedSection}
              registry={pilots}
              only={current ? b.members : undefined}
              rid={current?.row.id}
            />
          ) : (
            <StandingsTable c={c} s={s} rid={current?.row.id} registry={pilots} />
          )}
          {current && b.canEdit ? (
            <details class="fold" id="ranking-settings" open={Boolean(b.error)}>
              <summary>{t("Règle et pilotes de ce classement")} <span class="small muted">· {describeRule(current.rule)}</span></summary>
              <RankingForm c={c} r={current} />
              <h2 class="mt">{t("Ajouts et retraits à la main")}</h2>
              <RankingPilots c={c} r={current} pilots={pilots} />
              <DeleteRanking c={c} id={current.row.id} name={current.row.name} cls="mt" big />
            </details>
          ) : null}
        </>
      )}
    </>
  );
};
