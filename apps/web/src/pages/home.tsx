import type { FC } from "hono/jsx";
import type { CompetitionRow, User } from "../db.js";
import { km } from "../time.js";
import type { CompetitionSummary, CompetitionWinners } from "../standings.js";
import { locale, t } from "../i18n.js";
import { Bi, Layout, ErrorBox, dateRange } from "./layout.js";

type HomeComp = CompetitionRow & { owner?: string; scoredAt?: number; summary?: CompetitionSummary; winners?: CompetitionWinners | null };

const compStats = (c: HomeComp): string[] => {
  const s = c.summary;
  const out: string[] = [];
  if (s) {
    out.push(s.tasks === 1 ? t("1 manche") : t("{n} manches", { n: s.tasks }));
    out.push(s.pilots === 1 ? t("1 participant") : t("{n} participants", { n: s.pilots }));
    if (s.flown > 0) out.push(t("{n} km volés", { n: Math.round(s.flown / 1000).toLocaleString(locale()) }));
  }
  const w = c.winners;
  if (w?.overall && w.women && w.women !== w.overall) out.push(t("Vainqueurs : {a} et {b}", { a: w.overall, b: w.women }));
  else if (w?.overall || w?.women) out.push(t("Vainqueur : {name}", { name: (w.overall || w.women)! }));
  return out;
};

const CompList: FC<{ list: HomeComp[] }> = ({ list }) => (
  <ul class="list comps">
    {list.map((c) => (
      <li>
        <a href={`/competitions/${c.id}`}>
          <strong>{c.name}</strong>
        </a>
        <span class="muted small">
          {[
            c.location,
            dateRange(c.start_date, c.end_date),
            c.owner ? t("par {name}", { name: c.owner }) : null,
            c.scoredAt ? t("calculée le {date}", { date: new Date(c.scoredAt).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" }) }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {compStats(c).length ? <span class="comp-stats small">{compStats(c).join(" · ")}</span> : null}
      </li>
    ))}
  </ul>
);

/** Accueil : ses compétitions quand on est connecté, puis les compétitions récemment calculées, visibles de tous. */
export const HomePage: FC<{ user: User | null; mine: HomeComp[]; recent: HomeComp[]; error?: string | null; notice?: string | null }> = ({ user, mine, recent, error, notice }) => (
  <Layout title={user ? t("Mes compétitions") : t("Compétitions")} user={user}>
    {user ? (
      <>
        <div class="row" style="justify-content:space-between">
          <h1>{t("Mes compétitions")}</h1>
          <a class="btn primary" href="/competitions/new">
            <Bi n="plus" />
            {t("Nouvelle compétition")}
          </a>
        </div>
        <ErrorBox message={error} />
        {notice ? <div class="note">{notice}</div> : null}
        <div class="card">
          {mine.length ? <CompList list={mine} /> : <p class="muted">{t("Pas encore de compétition. Créez-en une pour y ajouter des manches.")}</p>}
        </div>
      </>
    ) : null}
    {user ? <h2>{t("Récemment calculées")}</h2> : <h1>{t("Compétitions récemment calculées")}</h1>}
    <div class="card">
      {recent.length ? <CompList list={recent} /> : <p class="muted">{t("Aucune compétition calculée pour l'instant.")}</p>}
    </div>
  </Layout>
);
