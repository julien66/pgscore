import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { DecisionKind, LeadingWarning, PilotResult, Task, TaskScoring } from "@pgscore/engine";
import type { CompetitionRow, DecisionRow, PilotRow, RunRow, TaskRow, TrackHistoryRow, TrackRow, User } from "./db.js";
import { DECISION_KINDS } from "./decisions.js";
import { GAP_PROFILES, LEADING_PROFILES, PENALTY_RULES, type CompetitionSettings, type StoredTask } from "./settings.js";
import { duration, km, localTime, utcHmsToLocal } from "./time.js";
import type { Standings } from "./standings.js";
import { lang, LANGS, locale, N_, t } from "./i18n.js";
import { PILOT_COLUMNS } from "./pilots.js";
import { describeRule, RULE_FIELDS, RULE_OPS, type Ranking } from "./rankings.js";

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#5d6678;--line:#dde1e8;--accent:#1f6feb;--accent-ink:#fff;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--chip:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--text:#e6e9ef;--muted:#9aa3b2;--line:#2a303b;--accent:#4c8dff;--accent-ink:#0b0e13;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--chip:#222833}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line)}
header .in{max-width:1200px;margin:0 auto;padding:10px 16px;display:flex;gap:16px;align-items:center}
header .brand{font-weight:700;font-size:17px;color:var(--text)}header .sp{flex:1}header .who{color:var(--muted);font-size:14px}
main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:24px;margin:4px 0 16px}h2{font-size:18px;margin:0 0 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ic{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;flex:none;color:var(--hue);background:color-mix(in srgb,var(--hue) 13%,var(--card))}
.crumbs{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:3px}
input[type=text],input[type=number],input[type=date],input[type=email],select,textarea{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);font:inherit}
textarea{font-family:ui-monospace,Menlo,monospace;font-size:12px;min-height:70px}
.check{display:flex;gap:8px;align-items:center;color:var(--text);font-size:14px}
button,.btn{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;cursor:pointer}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
button.link{border:0;background:none;color:var(--muted);padding:0;font-size:13px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.mt{margin-top:12px}
.muted{color:var(--muted)}.badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:8px;font-size:12px;background:var(--accent);color:var(--accent-ink)}details.replace{display:inline-block;margin-right:8px}details.replace summary{cursor:pointer;color:var(--accent);font-size:14px}details.replace form{display:flex;flex-direction:column;gap:6px;margin-top:6px;min-width:260px}.small{font-size:13px}
.err{background:color-mix(in srgb,var(--bad) 12%,var(--card));border:1px solid var(--bad);color:var(--text);padding:10px 12px;border-radius:8px;margin-bottom:16px}
.note{background:var(--chip);padding:10px 12px;border-radius:8px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.02em}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
.gap{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:8px 0 12px}.gap>div{border:1px solid var(--line);border-radius:10px;padding:8px 12px}.gap .big{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
details.fold>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px;margin-top:6px;user-select:none}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::before{content:"▸";display:inline-block;transition:transform .15s;color:var(--muted)}
details.fold[open]>summary::before{transform:rotate(90deg)}
details.card.fold>summary{color:inherit;margin:0}details.card.fold>summary h2{margin:0}details.card.fold[open]>summary{margin-bottom:8px}
.chip.t-bonus{background:#dcfce7;color:#166534}.chip.t-pen{background:#fee2e2;color:#991b1b}.chip.t-dec{background:#e0e7ff;color:#3730a3}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;background:var(--chip)}
.s-GOAL{color:var(--ok)}.s-ESS{color:var(--ok)}.s-MIND{color:var(--warn)}.s-ERREUR{color:var(--bad)}
.pen{color:var(--bad)}
.list{list-style:none;margin:0;padding:0}.list li{padding:10px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline}.list li:last-child{border:0}
.bar{height:8px;background:var(--chip);border-radius:99px;overflow:hidden}.bar>div{height:100%;background:var(--accent);transition:width .4s}
.bar.busy>div{width:30%;animation:busy 1.2s ease-in-out infinite alternate}@keyframes busy{from{margin-left:0}to{margin-left:70%}}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;vertical-align:-1px}@keyframes spin{to{transform:rotate(360deg)}}
.steps{list-style:none;margin:0 0 10px;padding:0}.steps li{padding:3px 0;display:flex;gap:8px;align-items:center}.steps .ic{width:16px;text-align:center}.steps li.done .ic{color:var(--ok)}.steps li.todo{color:var(--muted)}.steps li.now{font-weight:600}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.recent{list-style:none;margin:4px 0 0;padding:0;font-size:14px}.recent li{padding:2px 0}
.task-map{height:380px;border-radius:10px;border:1px solid var(--line);margin:4px 0 6px;z-index:0}
.tm-num span{display:flex;min-width:22px;padding:0 4px;box-sizing:border-box;width:max-content;height:22px;border-radius:50%;color:#fff;font:600 12px/22px system-ui;justify-content:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.tm-leg span{display:inline-block;background:rgba(17,24,39,.85);color:#fff;font:600 11px/16px system-ui;padding:1px 6px;border-radius:8px;white-space:nowrap}
.upl{margin-top:8px}.upl p{margin:4px 0}
.list .task-rk{margin-left:auto;color:var(--muted)}.list form.official{margin-left:12px}.list form.official .check{color:var(--muted)}
.lead-warn{color:var(--warn);cursor:help;margin-right:4px}
table.pilots td{padding:3px 4px}table.pilots input[type=text],table.pilots select{padding:4px 6px;font-size:13px}
table.pilots .in-s{width:72px}table.pilots .in-m{width:120px}table.pilots .in-l{width:190px}table.pilots tr.new td{background:var(--chip)}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 12px;border-bottom:1px solid var(--line)}.tabs a{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;color:var(--muted)}.tabs a.on{background:var(--card);border-color:var(--line);color:var(--text);font-weight:600;margin-bottom:-1px}
[data-swap].loading{opacity:.55;transition:opacity .15s}
.cond{margin-top:6px}.cond select{width:auto}.cond input{max-width:280px}
.ftv-part{font-weight:600}.ftv-raw{color:var(--muted);font-size:12px;margin-left:4px}.ftv-out{color:var(--muted)}
th .sub{display:block;text-transform:none;letter-spacing:0;font-weight:400}
.langs{display:flex;gap:2px;font-size:12px}.langs a{padding:2px 6px;border-radius:6px;color:var(--muted)}.langs a.on{background:var(--chip);color:var(--text);font-weight:600}
.center{max-width:420px;margin:60px auto;text-align:center}
`;

/** Icônes des titres (tracés Lucide, licence ISC), dans une pastille colorée. */
const ICONS = {
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  trophy:
    '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  sliders:
    '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
  pulse: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  gavel: '<path d="m14.5 12.5-8 8a2.119 2.119 0 1 1-3-3l8-8"/><path d="m16 16 6-6"/><path d="m8 8 6-6"/><path d="m9 7 8 8"/><path d="m21 11-8-8"/>',
  calc: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M8 6h8"/><path d="M16 14v4"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>',
  filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  play: '<path d="M6 3l14 9-14 9z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  userMinus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
} as const;
const ICON_COLORS = { blue: "#2563eb", amber: "#d97706", green: "#16a34a", red: "#dc2626", purple: "#7c3aed", teal: "#0d9488", gray: "#64748b", pink: "#db2777" } as const;

export const Ic: FC<{ n: keyof typeof ICONS; c: keyof typeof ICON_COLORS }> = ({ n, c }) => (
  <span class="ic" style={`--hue:${ICON_COLORS[c]}`} aria-hidden="true">
    {raw(
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`,
    )}
  </span>
);

/** Icône d'un bouton, de la couleur du texte. */
export const Bi: FC<{ n: keyof typeof ICONS }> = ({ n }) =>
  raw(
    `<svg class="bi" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`,
  );

export const Layout: FC<PropsWithChildren<{ title: string; user?: User | null; refresh?: number }>> = ({ title, user, refresh, children }) => (
  <>
  {raw("<!DOCTYPE html>")}
  <html lang={lang()}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {refresh ? <meta http-equiv="refresh" content={String(refresh)} /> : null}
      <title>{title} · pgscore</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <script src="/static/i18n.js" />
    </head>
    <body>
      <header>
        <div class="in">
          <a class="brand" href="/">
            pgscore
          </a>
          <span class="sp" />
          <nav class="langs" aria-label="Language">
            {Object.entries(LANGS).map(([code, name]) => (
              <a href={`/lang/${code}`} class={code === lang() ? "on" : ""} title={name} hreflang={code}>
                {code.toUpperCase()}
              </a>
            ))}
          </nav>
          {user ? (
            <>
              <span class="who">{user.name ?? user.email}</span>
              <form method="post" action="/auth/logout">
                <button class="link">{t("Se déconnecter")}</button>
              </form>
            </>
          ) : null}
        </div>
      </header>
      <main>{children}</main>
    </body>
  </html>
  </>
);

export const ErrorBox: FC<{ message?: string | null }> = ({ message }) => (message ? <div class="err">{message}</div> : null);

export const LoginPage: FC<{ providers: Array<{ href: string; label: string }>; devLogin: boolean; error?: string | null }> = ({
  providers,
  devLogin,
  error,
}) => (
  <Layout title={t("Connexion")}>
    <div class="center">
      <h1>pgscore</h1>
      <p class="muted">{t("Contrôle et scoring des compétitions de parapente cross-country.")}</p>
      <ErrorBox message={error} />
      {providers.map((p) => (
        <p>
          <a class="btn primary" href={p.href}>
            <Bi n="login" />
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

export const HomePage: FC<{ user: User; competitions: CompetitionRow[] }> = ({ user, competitions }) => (
  <Layout title={t("Mes compétitions")} user={user}>
    <div class="row" style="justify-content:space-between">
      <h1>{t("Mes compétitions")}</h1>
      <a class="btn primary" href="/competitions/new">
        <Bi n="plus" />
        {t("Nouvelle compétition")}
      </a>
    </div>
    <div class="card">
      {competitions.length ? (
        <ul class="list">
          {competitions.map((c) => (
            <li>
              <a href={`/competitions/${c.id}`}>
                <strong>{c.name}</strong>
              </a>
              <span class="muted small">
                {[c.location, dateRange(c.start_date, c.end_date)].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">{t("Pas encore de compétition. Créez-en une pour y ajouter des manches.")}</p>
      )}
    </div>
  </Layout>
);

function dateRange(a: string | null, b: string | null): string {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" });
  if (a && b && a !== b) return t("du {a} au {b}", { a: f(a), b: f(b) });
  return a ? f(a) : b ? f(b) : "";
}

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
          <label>{t("Leading")}</label>
          <select name="leadingProfile">
            {Object.entries(LEADING_PROFILES).map(([k, l]) => (
              <option value={k} selected={s.leadingProfile === k}>
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
          <input type="text" name="timeZone" value={s.timeZone} placeholder="Europe/Paris" />
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

export const NewCompetitionPage: FC<{ user: User; v: CompetitionFormValues; error?: string | null }> = ({ user, v, error }) => (
  <Layout title={t("Nouvelle compétition")} user={user}>
    <div class="crumbs">
      <a href="/">{t("Mes compétitions")}</a>
    </div>
    <h1>{t("Nouvelle compétition")}</h1>
    <ErrorBox message={error} />
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
  user: User;
  c: CompetitionRow;
  v: CompetitionFormValues;
  tasks: TaskRow[];
  board: Board;
  pilots: PilotRow[];
  airspaceCount: number | null;
  error?: string | null;
  notice?: string | null;
  edit?: boolean;
}> = ({ user, c, v, tasks, board, pilots, airspaceCount, error, notice, edit }) => (
  <Layout title={edit ? `${t("Éditer")} · ${c.name}` : c.name} user={user}>
    <div class="crumbs">
      <a href="/">{t("Mes compétitions")}</a>
    </div>
    <h1>{c.name}</h1>
    <nav class="tabs">
      <a href={`/competitions/${c.id}`} class={edit ? "" : "on"}>
        <Bi n="route" />
        {t("Manches et classements")}
      </a>
      <a href={`/competitions/${c.id}/edit`} class={edit ? "on" : ""}>
        <Bi n="sliders" />
        {t("Éditer")}
      </a>
    </nav>
    <ErrorBox message={error} />
    {notice ? <div class="note">{notice}</div> : null}
    {edit ? (
      <CompetitionEdit c={c} v={v} pilots={pilots} airspaceCount={airspaceCount} open={Boolean(error)} />
    ) : (
      <CompetitionMain c={c} tasks={tasks} board={board} />
    )}
  </Layout>
);

const CompetitionMain: FC<{ c: CompetitionRow; tasks: TaskRow[]; board: Board }> = ({ c, tasks, board }) => (
  <>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2><Ic n="route" c="blue" />{t("Manches")}</h2>
        <a class="btn primary" href={`/competitions/${c.id}/tasks/new`}>
          <Bi n="plus" />
          {t("Nouvelle manche")}
        </a>
      </div>
      {tasks.length ? (
        <ul class="list">
          {tasks.map((tk) => {
            const task = JSON.parse(tk.task) as Task;
            return (
              <li>
                <a href={`/tasks/${tk.id}`}>
                  <strong>{t("Manche {n}", { n: tk.number })}</strong>
                </a>
                <span class="muted small">
                  {[tk.date ? dateRange(tk.date, null) : null, task.type === "race" ? t("race") : t("time trial"), task.stopAnnouncement ? t("arrêtée") : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span class="small task-rk">
                  <a href={`/tasks/${tk.id}#results`}>{t("Général")}</a>
                  {board.rankings.map((x) => (
                    <>
                      {" · "}
                      <a href={`/tasks/${tk.id}?r=${x.r.row.id}#results`}>{t(x.r.row.name)}</a>
                    </>
                  ))}
                </span>
                <form method="post" action={`/tasks/${tk.id}/official`} class="official">
                  <input type="hidden" name="back" value="competition" />
                  <label class="check">
                    <input type="checkbox" name="official" value="1" checked={tk.official === 1} /> {t("officielle")}
                  </label>
                  <noscript>
                    <button class="link">{t("Enregistrer")}</button>
                  </noscript>
                </form>
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
    <script src="/static/competition.js" />
  </>
);

/** Onglet « Éditer » : réglages de la compétition, espace aérien, pilotes. */
const CompetitionEdit: FC<{ c: CompetitionRow; v: CompetitionFormValues; pilots: PilotRow[]; airspaceCount: number | null; open: boolean }> = ({
  c,
  v,
  pilots,
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

    <PilotsBlock c={c} pilots={pilots} open={open} />
    <script src="/static/competition.js" />
  </>
);

/** Pilotes inscrits : import FSDB/CSV et tableau modifiable. */
const PilotsBlock: FC<{ c: CompetitionRow; pilots: PilotRow[]; open: boolean }> = ({ c, pilots, open }) => {
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
    <details class="card fold" id="pilots" open={open}>
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
          </span>
        </h2>
      </summary>
      <form method="post" action={`/competitions/${c.id}/pilots/import`} enctype="multipart/form-data" class="row">
        <input type="file" name="file" accept=".fsdb,.xml,.csv,.txt" required />
        <button>
          <Bi n="upload" />
          {t("Importer")}
        </button>
        {pilots.length ? <a href={`/competitions/${c.id}/pilots.csv`}>{t("Exporter en CSV")}</a> : null}
      </form>
      <p class="small muted">
        {t(
          "Fichier FSDB (logiciel FS de la CIVL) ou CSV avec une ligne d'en-tête : numero, nom, genre, nation, civl_id, voile_marque, voile_modele, voile_classe, sellette_marque, sellette_modele, ptv_max_kg (seuls numero et nom sont obligatoires ; une colonne « voile » ou « sellette » seule est coupée en marque et modèle). Un pilote déjà inscrit sous le même numéro est mis à jour. Le numéro est celui des traces.",
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

/** Ce qui compte au classement général, en une ligne. */
const StandingsInfo: FC<{ s: Standings }> = ({ s }) => {
  const r = s.ranking;
  const notOfficial = s.tasks.filter((x) => !x.official).map((x) => x.t.number);
  const notCalculated = s.tasks.filter((x) => x.official && x.calculatedAt === null).map((x) => x.t.number);
  const stale = s.ranked.filter((x) => x.stale).map((x) => x.t.number);
  const list = (n: number[]) => n.map((x) => `M${x}`).join(", ");
  return (
    <>
      <p class="small muted">
        {r.ftvFactor > 0
          ? t("FTV {ftv} % : chaque pilote garde ses meilleures performances jusqu'à une validité totale de {total} ({points} points possibles).", {
              ftv: fr(r.ftvFactor * 100, 0),
              total: fr(r.fixedTotalValidity, 3),
              points: fr(r.fixedTotalValidity * 1000, 1),
            })
          : t("Sans FTV (facteur 0 %) : somme des points de chaque manche, sur {points} points possibles.", { points: fr(r.fixedTotalValidity * 1000, 1) })}
        {notOfficial.length ? ` ${t("Pas encore officielles, donc non comptées : {list}.", { list: list(notOfficial) })}` : ""}
        {notCalculated.length ? ` ${t("Officielles mais pas encore calculées : {list}.", { list: list(notCalculated) })}` : ""}
      </p>
      {stale.length ? (
        <div class="note">{t("Des changements ne sont pas encore calculés pour {list} : relancez le calcul de ces manches.", { list: list(stale) })}</div>
      ) : null}

    </>
  );
};

const FtvCell: FC<{ ts: { score: number; fraction: number; counted: number } | undefined; included: boolean }> = ({ ts, included }) => {
  if (!ts) return <td class="n ftv-out">{included ? "0,0" : ""}</td>;
  if (!included) return <td class="n ftv-out">{pts(ts.score)}</td>;
  if (ts.fraction >= 1) return <td class="n">{pts(ts.score)}</td>;
  if (ts.fraction <= 0) return <td class="n ftv-out" title={t("Non retenue (FTV)")}>({pts(ts.score)})</td>;
  return (
    <td class="n" title={t("Retenue à {pct} % (FTV)", { pct: fr(ts.fraction * 100, 1) })}>
      <span class="ftv-part">{pts(ts.counted)}</span>
      <span class="ftv-raw">({pts(ts.score)})</span>
    </td>
  );
};

export const StandingsTable: FC<{ c: CompetitionRow; s: Standings; limit?: number; rid?: number }> = ({ c, s, limit, rid }) => {
  const r = s.ranking;
  const q = rid ? `?r=${rid}` : "";
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
  return (
    <>
      <StandingsInfo s={s} />
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="n">#</th>
              <th>{t("Pilote")}</th>
              <th>{t("Nom")}</th>
              {s.ranked.map((x) => {
                const ti = info.get(String(x.t.id))!;
                return (
                  <th
                    class="n"
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
              <th class="n">{t("Total")}</th>
            </tr>
          </thead>
          <tbody>
            {pilots.map((p) => (
              <tr>
                <td class="n">{p.rank}</td>
                <td>{p.pilot}</td>
                <td>{p.name}</td>
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
      <p class="small mt">
        {limit && r.pilots.length > limit ? (
          <>
            <a class="swap" href={boardUrl(c, { r: rid, all: true })}>
              {t("Voir les {n} pilotes", { n: r.pilots.length })}
            </a>{" "}
            ·{" "}
          </>
        ) : null}
        <a href={`/competitions/${c.id}/standings.csv${q}`}>{t("Exporter en CSV")}</a>
        {r.ftvFactor > 0
          ? ` · ${t("en gras, la part retenue d'une manche comptée en partie ; entre parenthèses et en gris, le score de la manche non retenu")}`
          : ""}
      </p>
    </>
  );
};

/** Onglets des classements : général, puis les classements extraits. Ils restent sur la page de la compétition. */
const RankingTabs: FC<{ c: CompetitionRow; rankings: Array<{ id: number; name: string; count?: number }>; current: number | null; create?: boolean }> = ({
  c,
  rankings,
  current,
  create,
}) => (
  <nav class="tabs">
    <a href={boardUrl(c)} class={`swap${current === null && !create ? " on" : ""}`}>
      {t("Général")}
    </a>
    {rankings.map((r) => (
      <a href={boardUrl(c, { r: r.id })} class={`swap${current === r.id ? " on" : ""}`}>
        {t(r.name)}
        {r.count !== undefined ? <span class="muted small"> {r.count}</span> : null}
      </a>
    ))}
    <a href={boardUrl(c, { create: true })} class={`swap${create ? " on" : ""}`}>
      + {t("Nouveau classement")}
    </a>
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
  create: boolean;
  all: boolean;
  error?: string | null;
  notice?: string | null;
}

/** Adresse d'une vue du classement, sur la page de la compétition. */
export const boardUrl = (c: CompetitionRow, q: { r?: number | null; all?: boolean; create?: boolean } = {}) => {
  const p = new URLSearchParams();
  if (q.r) p.set("r", String(q.r));
  if (q.all) p.set("all", "1");
  if (q.create) p.set("new", "1");
  const qs = p.toString();
  return `/competitions/${c.id}${qs ? `?${qs}` : ""}#standings`;
};

const StandingsBoard: FC<{ c: CompetitionRow; b: Board }> = ({ c, b }) => {
  const { s, pilots, rankings, current, create } = b;
  const count = current ? (rankings.find((x) => x.r.row.id === current.row.id)?.count ?? 0) : 0;
  return (
    <>
      <RankingTabs c={c} rankings={rankings.map((x) => ({ id: x.r.row.id, name: x.r.row.name, count: x.count }))} current={current?.row.id ?? null} create={create} />
      <ErrorBox message={b.error} />
      {b.notice ? <div class="note">{b.notice}</div> : null}
      {create ? (
        <RankingForm c={c} r={null} />
      ) : (
        <>
          {current ? (
            <p class="small muted">
              {describeRule(current.rule)} ·{" "}
              {count > 1
                ? t("{n} pilotes inscrits dans ce classement", { n: count })
                : t("{n} pilote inscrit dans ce classement", { n: count })}
              ,{" "}
              {s.ranking.pilots.length > 1 ? t("{n} classés", { n: s.ranking.pilots.length }) : t("{n} classé", { n: s.ranking.pilots.length })}.{" "}
              {t("Même total qu'au général (mêmes manches, même FTV), rang recalculé.")}
              {!pilots.length ? ` ${t("Aucun pilote inscrit : importez la liste dans le bloc Pilotes de la compétition.")}` : ""}
            </p>
          ) : null}
          <StandingsTable c={c} s={s} rid={current?.row.id} limit={b.all ? undefined : 10} />
          {current ? (
            <details class="fold" id="ranking-settings" open={Boolean(b.error)}>
              <summary>{t("Règle et pilotes de ce classement")}</summary>
              <RankingForm c={c} r={current} />
              <h2 class="mt">{t("Ajouts et retraits à la main")}</h2>
              <RankingPilots c={c} r={current} pilots={pilots} />
              <form method="post" action={`/competitions/${c.id}/rankings/${current.row.id}/delete`} class="mt">
                <button>
                  <Bi n="trash" />
                  {t("Supprimer ce classement")}
                </button>
              </form>
            </details>
          ) : null}
        </>
      )}
    </>
  );
};

export const NewTaskPage: FC<{ user: User; c: CompetitionRow; number: number; error?: string | null; date?: string }> = ({
  user,
  c,
  number,
  error,
  date,
}) => (
  <Layout title={t("Nouvelle manche")} user={user}>
    <div class="crumbs">
      <a href="/">{t("Mes compétitions")}</a> › <a href={`/competitions/${c.id}`}>{c.name}</a>
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
  user: User;
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
  running: boolean;
  error?: string | null;
  notice?: string | null;
  edit?: boolean;
}> = ({ user, c, t: tk, task, settings, distances, tracks, history, decisions, geometry, run, done, rankings, ranking, running, error, notice, edit }) => {
  const tz = settings.timeZone;
  const loc = (hms?: string) => (hms ? utcHmsToLocal(hms, tk.date, tz) : "");
  const results = done?.results ? (JSON.parse(done.results) as TaskScoring) : null;
  // Traces modifiées après le lancement du dernier calcul : le classement affiché n'en tient pas compte.
  const lastChange = Math.max(0, ...tracks.map((x) => x.uploaded_at), ...history.map((h) => h.ended_at), tk.scoring_changed_at ?? 0);
  const stale = done !== null && lastChange > done.started_at;
  const versions = new Map<string, number>();
  for (const h of history) versions.set(h.pilot_key, (versions.get(h.pilot_key) ?? 0) + 1);
  const when = (ms: number) => `${new Date(ms).toLocaleDateString(locale(), { timeZone: tz, day: "2-digit", month: "2-digit" })} ${localTime(ms, tz)}`;
  const fileUrl = (sha: string) => `/tasks/${tk.id}/files/${sha}`;
  return (
    <Layout title={`${edit ? `${t("Éditer")} · ` : ""}${t("Manche {n}", { n: tk.number })} · ${c.name}`} user={user}>
      <div class="crumbs">
        <a href="/">{t("Mes compétitions")}</a> › <a href={`/competitions/${c.id}`}>{c.name}</a>
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
        <a href={`/tasks/${tk.id}/edit`} class={edit ? "on" : ""}>
          <Bi n="sliders" />
          {t("Éditer")}
        </a>
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
            <label>{t("Manche arrêtée : heure d'annonce (locale)")}</label>
            <input type="text" name="stop" placeholder="HH:MM" value={loc(task.stopAnnouncement)} />
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
            <label>{t("Fin de manche pour le leading (locale)")}</label>
            <input type="text" name="taskEndTime" placeholder={t("dernier posé")} value={loc(task.taskEndTime)} />
          </div>
          <div style="align-self:end">
            <button>
              <Bi n="save" />
              {t("Enregistrer")}
            </button>
          </div>
        </form>
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
              "Fichiers IGC ou archive .zip. Le pilote est reconnu au numéro en fin de nom de fichier ; une trace envoyée pour un pilote qui en a déjà une la remplace. Pour un fichier nommé autrement, utilisez « Remplacer » sur la ligne du pilote.",
            )}
          </span>
        </form>
        {tracks.length ? (
          <details class="mt">
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
                        <a href={`/tasks/${tk.id}/pilots/${encodeURIComponent(tr.pilot_key)}`}>{tr.pilot_name ?? tr.pilot_key}</a>
                      </td>
                      <td>
                        <a class="muted" href={fileUrl(tr.sha256)}>
                          {tr.filename}
                        </a>
                        {versions.get(tr.pilot_key) ? <span class="badge">v{(versions.get(tr.pilot_key) ?? 0) + 1}</span> : null}
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
                        <form method="post" action={`/tasks/${tk.id}/tracks/${tr.id}/delete`}>
                          <button class="link">{t("Retirer")}</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                    <td>{d.reason}</td>
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
        {results && rankings.length ? (
          <nav class="tabs">
            <a href={`/tasks/${tk.id}#results`} class={`swap${ranking ? "" : " on"}`}>
              {t("Général")}
            </a>
            {rankings.map((x) => (
              <a href={`/tasks/${tk.id}?r=${x.id}#results`} class={`swap${ranking?.id === x.id ? " on" : ""}`}>
                {t(x.name)}
              </a>
            ))}
          </nav>
        ) : null}
        {running ? (
          <div class="note">
            <span class="spin" /> {t("Calcul en cours.")} <a href={`/tasks/${tk.id}/edit#run-card`}>{t("Suivre le calcul")}</a>
          </div>
        ) : null}
        {results ? (
          <>
            {stale && !running ? (
              <div class="note">
                {t("Des traces, réglages ou décisions ont changé depuis ce calcul : relancez-le pour mettre le classement à jour.")}{" "}
                <a href={`/tasks/${tk.id}/edit#run-card`}>{t("Relancer le calcul")}</a>
              </div>
            ) : null}
            <p class="small muted">
              <RunStatus run={done} tz={settings.timeZone} taskId={tk.id} inline />
            </p>
            <Results r={results} tz={settings.timeZone} settings={settings} taskId={tk.id} only={ranking?.members} rid={ranking?.id} />
          </>
        ) : running ? null : (
          <p class="muted">
            {t("Pas encore de résultats.")} <a href={`/tasks/${tk.id}/edit`}>{t("Envoyer les traces et lancer le calcul")}</a>
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
    </>
  );
};

/** Où en est le dernier calcul. inline : seulement la phrase du bilan (page des résultats). */
const RunStatus: FC<{ run: RunRow | null; tz: string; taskId: number; inline?: boolean }> = ({ run, tz, taskId, inline }) => {
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

const fr = (v: number, digits: number) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

const pts = (v: number | null | undefined) => (v === null || v === undefined ? "" : fr(v, 1));

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

const Results: FC<{ r: TaskScoring; tz: string; settings: CompetitionSettings; taskId: number; only?: Set<string>; rid?: number }> = ({
  r,
  tz,
  settings,
  taskId,
  only,
  rid,
}) => {
  // Classement extrait : seulement ses pilotes, rang recalculé ; les points restent ceux de la manche.
  const shown = only ? r.pilots.filter((p) => only.has(p.id)) : r.pilots;
  const stopped = r.pilots.some((p) => p.stop);
  const counts = (s: string) => r.pilots.filter((p) => p.status === s).length;
  // Calcul fait avant l'arrivée des points GAP : il faut le relancer.
  const withPoints = Boolean(r.gap);
  const leadWarn = r.pilots.filter((p) => p.leadingWarnings?.length).length;
  return (
    <>
      {withPoints ? <GapSummary r={r} settings={settings} /> : <div class="note">{t("Ce calcul date d'avant les points GAP : relancez-le pour les obtenir.")}</div>}
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
        · {t("leading {profile}", { profile: t(LEADING_PROFILES[settings.leadingProfile]) })} ·{" "}
        <a href={`/tasks/${taskId}/results.csv${rid ? `?r=${rid}` : ""}`}>{t("exporter en CSV")}</a>
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
                  <th class="n">{t("Pts distance")}</th>
                  <th class="n">{t("Pts temps")}</th>
                  <th class="n">{t("Pts leading")}</th>
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
                    <td class="n">{pts(p.points?.distance)}</td>
                    <td class="n">{pts(p.points?.time)}</td>
                    <td class="n">{pts(p.points?.leading)}</td>
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

export function resultsCsv(r: TaskScoring, tz: string): string {
  const head = [
    "rang", "pilote", "nom", "statut", "depart", "ess", "temps_s", "distance_km", "alt_arret_m", "lc", "leading",
    "pts_distance", "pts_temps", "pts_leading", "penalite_pts", "total", "espace_aerien", "profondeur_m", "penalite", "decisions", "alerte_leading",
  ];
  const q = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
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
  ]);
  return [head, ...rows].map((r) => r.map(q).join(",")).join("\n") + "\n";
}

const VIEWER_CSS = `
main{max-width:none}
#viewer{display:flex;flex-direction:column;gap:10px}
.v-top{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.v-tabs button.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.v-play{display:flex;gap:6px;align-items:center;flex:1;min-width:280px}.v-play input{flex:1}
.v-main{display:grid;grid-template-columns:1fr 340px;gap:10px;height:62vh;min-height:420px}
@media (max-width:900px){.v-main{grid-template-columns:1fr;height:auto}.v-maps{height:55vh}}
.v-maps,#v-map,#v-3d{height:100%;border-radius:10px;overflow:hidden}
.v-maps{border:1px solid var(--line)}
.v-side{overflow:auto;display:flex;flex-direction:column;gap:10px}
.v-box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.v-box h3{margin:0 0 6px;font-size:15px}
.v-box dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;font-size:14px}.v-box dt{color:var(--muted)}.v-box dd{margin:0;font-variant-numeric:tabular-nums}
.v-events{margin:0;padding-left:18px;font-size:14px}.v-events li{margin:4px 0;cursor:pointer}.v-events li:hover{text-decoration:underline}
.v-events li.miss{color:#c2410c}.v-events li.bad,.bad{color:var(--bad)}.v-events li.later{color:var(--muted)}
.v-versions{font-size:14px}.v-versions tr.on{background:var(--chip)}.v-versions td{vertical-align:top}
.v-sw{display:inline-block;width:14px;height:14px;border-radius:3px;margin-top:3px}
#v-baro{width:100%;height:170px;background:var(--card);border:1px solid var(--line);border-radius:10px;cursor:crosshair}
`;

export const ViewerPage: FC<{ user: User; c: CompetitionRow; t: TaskRow; pilotKey: string; pilotName: string; data: string }> = ({
  user,
  c,
  t: tk,
  pilotKey,
  pilotName,
  data,
}) => (
  <Layout title={`${pilotName} · ${t("Manche {n}", { n: tk.number })}`} user={user}>
    <link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
    <style dangerouslySetInnerHTML={{ __html: VIEWER_CSS }} />
    <div class="crumbs">
      <a href="/">{t("Mes compétitions")}</a> › <a href={`/competitions/${c.id}`}>{c.name}</a> › <a href={`/tasks/${tk.id}`}>{t("Manche {n}", { n: tk.number })}</a>
    </div>
    <h1>
      {pilotName} <span class="muted">· {pilotKey}</span>
    </h1>
    <div id="viewer" />
    <script type="application/json" id="viewer-data" dangerouslySetInnerHTML={{ __html: data.replace(/</g, "\\u003c") }} />
    <script src="/vendor/leaflet/leaflet.js" />
    <script src="/static/basemaps.js" />
    <script src="/static/viewer.js" />
  </Layout>
);

export const NotFound: FC<{ user?: User | null }> = ({ user }) => (
  <Layout title={t("Introuvable")} user={user ?? null}>
    <h1>{t("Page introuvable")}</h1>
    <p>
      <a href="/">{t("Retour à mes compétitions")}</a>
    </p>
  </Layout>
);

export type { Child };
