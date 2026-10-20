import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { DecisionKind, PilotResult, Task, TaskScoring } from "@pgscore/engine";
import type { CompetitionRow, DecisionRow, PilotRow, RunRow, TaskRow, TrackHistoryRow, TrackRow, User } from "./db.js";
import { DECISION_KINDS } from "./decisions.js";
import { GAP_PROFILES, LEADING_PROFILES, PENALTY_RULES, type CompetitionSettings, type StoredTask } from "./settings.js";
import { duration, km, localTime, utcHmsToLocal } from "./time.js";
import type { Standings } from "./standings.js";
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
.list form.official{margin-left:auto}.list form.official .check{color:var(--muted)}
.lead-warn{color:var(--warn);cursor:help;margin-right:4px}
table.pilots td{padding:3px 4px}table.pilots input[type=text],table.pilots select{padding:4px 6px;font-size:13px}
table.pilots .in-s{width:72px}table.pilots .in-m{width:120px}table.pilots .in-l{width:190px}table.pilots tr.new td{background:var(--chip)}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 12px;border-bottom:1px solid var(--line)}.tabs a{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;color:var(--muted)}.tabs a.on{background:var(--card);border-color:var(--line);color:var(--text);font-weight:600;margin-bottom:-1px}
.cond{margin-top:6px}.cond select{width:auto}.cond input{max-width:280px}
.ftv-part{font-weight:600}.ftv-raw{color:var(--muted);font-size:12px;margin-left:4px}.ftv-out{color:var(--muted)}
th .sub{display:block;text-transform:none;letter-spacing:0;font-weight:400}
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
  <html lang="fr">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {refresh ? <meta http-equiv="refresh" content={String(refresh)} /> : null}
      <title>{title} · pgscore</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header>
        <div class="in">
          <a class="brand" href="/">
            pgscore
          </a>
          <span class="sp" />
          {user ? (
            <>
              <span class="who">{user.name ?? user.email}</span>
              <form method="post" action="/auth/logout">
                <button class="link">Se déconnecter</button>
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
  <Layout title="Connexion">
    <div class="center">
      <h1>pgscore</h1>
      <p class="muted">Contrôle et scoring des compétitions de parapente cross-country.</p>
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
        <div class="note">Aucun service de connexion n'est configuré (variables GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET).</div>
      ) : null}
      {devLogin ? (
        <form method="post" action="/auth/dev" class="card mt" style="text-align:left">
          <h2><Ic n="key" c="gray" />Connexion de développement</h2>
          <p class="small muted">Active seulement avec DEV_LOGIN=1, pour tester sans Google.</p>
          <label>E-mail</label>
          <input type="email" name="email" required value="dev@pgscore.local" />
          <label class="mt">Nom</label>
          <input type="text" name="name" value="Organisateur test" />
          <p>
            <button class="primary">
              <Bi n="login" />
              Entrer
            </button>
          </p>
        </form>
      ) : null}
    </div>
  </Layout>
);

export const HomePage: FC<{ user: User; competitions: CompetitionRow[] }> = ({ user, competitions }) => (
  <Layout title="Mes compétitions" user={user}>
    <div class="row" style="justify-content:space-between">
      <h1>Mes compétitions</h1>
      <a class="btn primary" href="/competitions/new">
        <Bi n="plus" />
        Nouvelle compétition
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
        <p class="muted">Pas encore de compétition. Créez-en une pour y ajouter des manches.</p>
      )}
    </div>
  </Layout>
);

function dateRange(a: string | null, b: string | null): string {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  if (a && b && a !== b) return `du ${f(a)} au ${f(b)}`;
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
          <label>Nom</label>
          <input type="text" name="name" required value={v.name} />
        </div>
        <div>
          <label>Lieu</label>
          <input type="text" name="location" value={v.location} />
        </div>
        <div>
          <label>Début</label>
          <input type="date" name="start_date" value={v.start_date} />
        </div>
        <div>
          <label>Fin</label>
          <input type="date" name="end_date" value={v.end_date} />
        </div>
      </div>
      <h2 class="mt"><Ic n="sliders" c="gray" />Paramètres de la formule (S7F, chapitre 5)</h2>
      <div class="grid">
        <div>
          <label>Distance nominale (km)</label>
          <input type="number" step="0.1" min="0" name="nominalDistance" value={String(s.nominalDistance / 1000)} />
        </div>
        <div>
          <label>Distance minimale (km)</label>
          <input type="number" step="0.1" min="0" name="minimumDistance" value={String(s.minimumDistance / 1000)} />
        </div>
        <div>
          <label>Temps nominal (min)</label>
          <input type="number" step="1" min="1" name="nominalTime" value={String(s.nominalTime / 60)} />
        </div>
        <div>
          <label>Facteur FTV (%)</label>
          <input type="number" step="1" min="0" max="100" name="ftvFactor" value={String(Math.round(s.ftvFactor * 100))} />
        </div>
        <div>
          <label>Formule de points</label>
          <select name="gapProfile">
            {Object.entries(GAP_PROFILES).map(([k, l]) => (
              <option value={k} selected={s.gapProfile === k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Leading</label>
          <select name="leadingProfile">
            {Object.entries(LEADING_PROFILES).map(([k, l]) => (
              <option value={k} selected={s.leadingProfile === k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Pénalité d'espace aérien</label>
          <select name="airspacePenaltyRule">
            {Object.entries(PENALTY_RULES).map(([k, l]) => (
              <option value={k} selected={s.airspacePenaltyRule === k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Fuseau horaire du site</label>
          <input type="text" name="timeZone" value={s.timeZone} placeholder="Europe/Paris" />
        </div>
        <div style="align-self:end">
          <label class="check">
            <input type="checkbox" name="roundAirspaceLimits" checked={s.roundAirspaceLimits} /> Arrondir au mètre les limites en pieds (SVL)
          </label>
        </div>
      </div>
    </>
  );
};

export const NewCompetitionPage: FC<{ user: User; v: CompetitionFormValues; error?: string | null }> = ({ user, v, error }) => (
  <Layout title="Nouvelle compétition" user={user}>
    <div class="crumbs">
      <a href="/">Mes compétitions</a>
    </div>
    <h1>Nouvelle compétition</h1>
    <ErrorBox message={error} />
    <form method="post" action="/competitions" enctype="multipart/form-data" class="card">
      <CompetitionFields v={v} />
      <h2 class="mt"><Ic n="shield" c="red" />Espace aérien</h2>
      <label>Fichier OpenAir (facultatif, modifiable ensuite)</label>
      <input type="file" name="airspace" accept=".txt,.air,.openair" />
      <p class="mt">
        <button class="primary">
          <Bi n="plus" />
          Créer la compétition
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
  standings: Standings;
  pilots: PilotRow[];
  rankings: Array<{ id: number; name: string }>;
  airspaceCount: number | null;
  error?: string | null;
  notice?: string | null;
  edit?: boolean;
}> = ({ user, c, v, tasks, standings, pilots, rankings, airspaceCount, error, notice, edit }) => (
  <Layout title={edit ? `Éditer · ${c.name}` : c.name} user={user}>
    <div class="crumbs">
      <a href="/">Mes compétitions</a>
    </div>
    <h1>{c.name}</h1>
    <nav class="tabs">
      <a href={`/competitions/${c.id}`} class={edit ? "" : "on"}>
        <Bi n="route" />
        Manches et classements
      </a>
      <a href={`/competitions/${c.id}/edit`} class={edit ? "on" : ""}>
        <Bi n="sliders" />
        Éditer
      </a>
    </nav>
    <ErrorBox message={error} />
    {notice ? <div class="note">{notice}</div> : null}
    {edit ? (
      <CompetitionEdit c={c} v={v} pilots={pilots} airspaceCount={airspaceCount} open={Boolean(error)} />
    ) : (
      <CompetitionMain c={c} tasks={tasks} standings={standings} rankings={rankings} />
    )}
  </Layout>
);

const CompetitionMain: FC<{ c: CompetitionRow; tasks: TaskRow[]; standings: Standings; rankings: Array<{ id: number; name: string }> }> = ({
  c,
  tasks,
  standings,
  rankings,
}) => (
  <>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2><Ic n="route" c="blue" />Manches</h2>
        <a class="btn primary" href={`/competitions/${c.id}/tasks/new`}>
          <Bi n="plus" />
          Nouvelle manche
        </a>
      </div>
      {tasks.length ? (
        <ul class="list">
          {tasks.map((t) => {
            const task = JSON.parse(t.task) as Task;
            return (
              <li>
                <a href={`/tasks/${t.id}`}>
                  <strong>Manche {t.number}</strong>
                </a>
                <span class="muted small">
                  {[t.date ? dateRange(t.date, null) : null, task.type === "race" ? "race" : "time trial", task.stopAnnouncement ? "arrêtée" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <form method="post" action={`/tasks/${t.id}/official`} class="official">
                  <input type="hidden" name="back" value="competition" />
                  <label class="check">
                    <input type="checkbox" name="official" value="1" checked={t.official === 1} /> officielle
                  </label>
                  <noscript>
                    <button class="link">Enregistrer</button>
                  </noscript>
                </form>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="muted">Pas encore de manche.</p>
      )}
    </div>

    <div class="card" id="standings">
      <h2><Ic n="trophy" c="amber" />Classement général</h2>
      <RankingTabs c={c} rankings={rankings} current={null} />
      <StandingsTable c={c} s={standings} limit={10} />
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
          Compétition
          <span class="muted small">
            {GAP_PROFILES[v.settings.gapProfile].split(" (")[0]} · FTV {Math.round(v.settings.ftvFactor * 100)} % · nominale {v.settings.nominalDistance / 1000} km,{" "}
            {v.settings.nominalTime / 60} min
          </span>
        </h2>
      </summary>
      <form method="post" action={`/competitions/${c.id}`}>
        <CompetitionFields v={v} />
        <p class="mt">
          <button class="primary">
            <Bi n="save" />
            Enregistrer
          </button>
        </p>
      </form>
    </details>

    <details class="card fold" id="airspace" open={open}>
      <summary>
        <h2>
          <Ic n="shield" c="red" />
          Espace aérien
          <span class="muted small">{c.airspace_name ? `${c.airspace_name} · ${airspaceCount} zone${airspaceCount === 1 ? "" : "s"}` : "aucun fichier"}</span>
        </h2>
      </summary>
      {c.airspace_name ? null : <p class="muted">Aucun fichier : les traces ne sont pas contrôlées pour l'espace aérien.</p>}
      <form method="post" action={`/competitions/${c.id}/airspace`} enctype="multipart/form-data" class="row">
        <input type="file" name="airspace" accept=".txt,.air,.openair" required />
        <button>
          <Bi n="upload" />
          {c.airspace_name ? "Remplacer" : "Envoyer"}
        </button>
      </form>
      <p class="small muted">Limites lues en AMSL ; niveaux de vol convertis à 1013,25 hPa puis abaissés de 100 m. Les limites AGL sont ignorées.</p>
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
    return <input type="text" name={name} value={v === null ? "" : String(v)} class={`in-${size}`} placeholder={p ? "" : PILOT_COLUMNS.find((x) => x.key === key)!.label} />;
  };
  return (
    <details class="card fold" id="pilots" open={open}>
      <summary>
        <h2>
          <Ic n="users" c="purple" />
          Pilotes{" "}
          <span class="muted small">
            {pilots.length ? `${pilots.length} inscrits${women ? ` · ${women} femmes` : ""}` : "aucun inscrit"}
          </span>
        </h2>
      </summary>
      <form method="post" action={`/competitions/${c.id}/pilots/import`} enctype="multipart/form-data" class="row">
        <input type="file" name="file" accept=".fsdb,.xml,.csv,.txt" required />
        <button>
          <Bi n="upload" />
          Importer
        </button>
        {pilots.length ? <a href={`/competitions/${c.id}/pilots.csv`}>Exporter en CSV</a> : null}
      </form>
      <p class="small muted">
        Fichier FSDB (logiciel FS de la CIVL) ou CSV avec une ligne d'en-tête : numero, nom, genre, nation, civl_id, voile_marque, voile_modele,
        voile_classe, sellette_marque, sellette_modele, ptv_max_kg (seuls numero et nom sont obligatoires ; une colonne « voile » ou « sellette » seule est
        coupée en marque et modèle). Un pilote déjà inscrit sous le même numéro est mis à jour. Le numéro est celui des traces.
      </p>
      <form method="post" action={`/competitions/${c.id}/pilots`}>
        <div class="scroll">
          <table class="pilots">
            <thead>
              <tr>
                {PILOT_COLUMNS.map((col) => (
                  <th>{col.label}</th>
                ))}
                <th>Retirer</th>
              </tr>
            </thead>
            <tbody>
              {pilots.map((p) => (
                <tr>
                  {PILOT_COLUMNS.map((col) => (
                    <td>{cell(p, col.key)}</td>
                  ))}
                  <td>
                    <input type="checkbox" name={`del.${p.id}`} value="1" title="Retirer ce pilote à l'enregistrement" />
                  </td>
                </tr>
              ))}
              <tr class="new">
                {PILOT_COLUMNS.map((col) => (
                  <td>{cell(null, col.key)}</td>
                ))}
                <td class="small muted">nouveau</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt">
          <button class="primary">
            <Bi n="save" />
            Enregistrer les pilotes
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
          ? `FTV ${fr(r.ftvFactor * 100, 0)} % : chaque pilote garde ses meilleures performances jusqu'à une validité totale de ${fr(r.fixedTotalValidity, 3)} (${fr(r.fixedTotalValidity * 1000, 1)} points possibles).`
          : `Sans FTV (facteur 0 %) : somme des points de chaque manche, sur ${fr(r.fixedTotalValidity * 1000, 1)} points possibles.`}
        {notOfficial.length ? ` Pas encore officielles, donc non comptées : ${list(notOfficial)}.` : ""}
        {notCalculated.length ? ` Officielles mais pas encore calculées : ${list(notCalculated)}.` : ""}
      </p>
      {stale.length ? <div class="note">Des changements ne sont pas encore calculés pour {list(stale)} : relancez le calcul de ces manches.</div> : null}
    </>
  );
};

const FtvCell: FC<{ ts: { score: number; fraction: number; counted: number } | undefined; included: boolean }> = ({ ts, included }) => {
  if (!ts) return <td class="n ftv-out">{included ? "0,0" : ""}</td>;
  if (!included) return <td class="n ftv-out">{pts(ts.score)}</td>;
  if (ts.fraction >= 1) return <td class="n">{pts(ts.score)}</td>;
  if (ts.fraction <= 0) return <td class="n ftv-out" title="Non retenue (FTV)">({pts(ts.score)})</td>;
  return (
    <td class="n" title={`Retenue à ${fr(ts.fraction * 100, 1)} % (FTV)`}>
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
            ? "Aucune manche officielle calculée : cochez « officielle » dans la liste des manches pour qu'une manche compte."
            : "Pas encore de manche."}
        </p>
      </>
    );
  const pilots = limit ? r.pilots.slice(0, limit) : r.pilots;
  if (rid && !pilots.length) return <p class="muted">Aucun pilote classé dans ce classement.</p>;
  const info = new Map(r.tasks.map((t) => [t.key, t]));
  return (
    <>
      <StandingsInfo s={s} />
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="n">#</th>
              <th>Pilote</th>
              <th>Nom</th>
              {s.ranked.map((x) => {
                const t = info.get(String(x.t.id))!;
                return (
                  <th
                    class="n"
                    title={
                      t.excluded
                        ? `Non comptée : ${t.excluded}`
                        : `Validité FTV = points du vainqueur / 1000. Validité GAP de la manche ${fr(x.validity ?? 0, 3)}, ${fr(x.available ?? 0, 1)} points disponibles.`
                    }
                  >
                    <a href={`/tasks/${x.t.id}`}>M{x.t.number}</a>
                    <span class="sub">{t.included ? `val. ${fr(t.validity * 100, 1)} %` : "non comptée"}</span>
                  </th>
                );
              })}
              <th class="n">Total</th>
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
            <a href={`/competitions/${c.id}/standings${q}`}>Voir les {r.pilots.length} pilotes</a> ·{" "}
          </>
        ) : null}
        <a href={`/competitions/${c.id}/standings.csv${q}`}>Exporter en CSV</a>
        {r.ftvFactor > 0 ? " · en gras, la part retenue d'une manche comptée en partie ; entre parenthèses et en gris, le score de la manche non retenu" : ""}
      </p>
    </>
  );
};

/** Onglets des classements : général, puis les classements extraits. */
const RankingTabs: FC<{ c: CompetitionRow; rankings: Array<{ id: number; name: string; count?: number }>; current: number | null; create?: boolean }> = ({
  c,
  rankings,
  current,
  create,
}) => (
  <nav class="tabs">
    <a href={`/competitions/${c.id}/standings`} class={current === null && !create ? "on" : ""}>
      Général
    </a>
    {rankings.map((r) => (
      <a href={`/competitions/${c.id}/standings?r=${r.id}`} class={current === r.id ? "on" : ""}>
        {r.name}
        {r.count !== undefined ? <span class="muted small"> {r.count}</span> : null}
      </a>
    ))}
    <a href={`/competitions/${c.id}/standings?new=1`} class={create ? "on" : ""}>
      + Nouveau classement
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
          <label>Nom du classement</label>
          <input type="text" name="name" value={r?.row.name ?? ""} placeholder="Serial, Lightweight, Sport…" required />
        </div>
      </div>
      <p class="small muted mt">
        Pilotes retenus : ceux qui vérifient toutes les conditions remplies (données du bloc Pilotes). Plusieurs valeurs séparées par des virgules :
        « EN-C, EN-D ». Sans condition, le classement ne contient que les pilotes ajoutés à la main.
      </p>
      {[1, 2, 3, 4].map((i) => {
        const k = conds[i - 1];
        return (
          <div class="row cond">
            <select name={`field${i}`}>
              <option value="">—</option>
              {Object.entries(RULE_FIELDS).map(([f, label]) => (
                <option value={f} selected={k?.field === f}>
                  {label}
                </option>
              ))}
            </select>
            <select name={`op${i}`}>
              {Object.entries(RULE_OPS).map(([o, label]) => (
                <option value={o} selected={(k?.op ?? "in") === o}>
                  {label}
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
          {r ? "Enregistrer la règle" : "Créer le classement"}
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
          <input type="text" name="pilot" placeholder="N° du pilote" class="in-s" required style="width:120px" />
          <button name="how" value="include">
            <Bi n="userPlus" />
            Ajouter au classement
          </button>
          <button name="how" value="exclude">
            <Bi n="userMinus" />
            Retirer du classement
          </button>
        </form>
      </div>
      {manual.length ? (
        <ul class="list">
          {manual.map(([key, inc]) => (
            <li>
              <span class={`chip ${inc ? "t-bonus" : "t-pen"}`}>{inc ? "ajouté" : "retiré"}</span>
              <span>
                {key} {names.get(key) ?? ""}
              </span>
              <form method="post" action={action} style="margin-left:auto">
                <input type="hidden" name="pilot" value={key} />
                <button class="link" name="how" value="reset">
                  revenir à la règle
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p class="small muted">Aucun ajout ni retrait à la main.</p>
      )}
    </>
  );
};

export const StandingsPage: FC<{
  user: User;
  c: CompetitionRow;
  s: Standings;
  overall: Standings;
  pilots: PilotRow[];
  rankings: Array<{ r: Ranking; count: number }>;
  current: Ranking | null;
  create: boolean;
  error?: string | null;
  notice?: string | null;
}> = ({ user, c, s, pilots, rankings, current, create, error, notice }) => {
  const title = create ? "Nouveau classement" : current ? `Classement ${current.row.name.toLowerCase()}` : "Classement général";
  const count = current ? rankings.find((x) => x.r.row.id === current.row.id)!.count : 0;
  return (
    <Layout title={`${title} · ${c.name}`} user={user}>
      <div class="crumbs">
        <a href="/">Mes compétitions</a> › <a href={`/competitions/${c.id}`}>{c.name}</a>
      </div>
      <h1>{title}</h1>
      <ErrorBox message={error} />
      {notice ? <div class="note">{notice}</div> : null}
      <RankingTabs c={c} rankings={rankings.map((x) => ({ id: x.r.row.id, name: x.r.row.name, count: x.count }))} current={current?.row.id ?? null} create={create} />
      {create ? (
        <div class="card">
          <RankingForm c={c} r={null} />
        </div>
      ) : (
        <>
          {current ? (
            <p class="small muted">
              {describeRule(current.rule)} · {count} pilote{count > 1 ? "s" : ""} inscrit{count > 1 ? "s" : ""} dans ce classement,{" "}
              {s.ranking.pilots.length} classé{s.ranking.pilots.length > 1 ? "s" : ""}. Même total qu'au général (mêmes manches, même FTV), rang recalculé.
              {!pilots.length ? " Aucun pilote inscrit : importez la liste dans le bloc Pilotes de la compétition." : ""}
            </p>
          ) : null}
          <div class="card">
            <StandingsTable c={c} s={s} rid={current?.row.id} />
          </div>
          {current ? (
            <details class="card fold" id="ranking-settings">
              <summary>
                <h2><Ic n="filter" c="purple" />Règle et pilotes de ce classement</h2>
              </summary>
              <RankingForm c={c} r={current} />
              <h2 class="mt">Ajouts et retraits à la main</h2>
              <RankingPilots c={c} r={current} pilots={pilots} />
              <form method="post" action={`/competitions/${c.id}/rankings/${current.row.id}/delete`} class="mt">
                <button>
                  <Bi n="trash" />
                  Supprimer ce classement
                </button>
              </form>
            </details>
          ) : null}
        </>
      )}
    </Layout>
  );
};

export const NewTaskPage: FC<{ user: User; c: CompetitionRow; number: number; error?: string | null; date?: string }> = ({
  user,
  c,
  number,
  error,
  date,
}) => (
  <Layout title="Nouvelle manche" user={user}>
    <div class="crumbs">
      <a href="/">Mes compétitions</a> › <a href={`/competitions/${c.id}`}>{c.name}</a>
    </div>
    <h1>Nouvelle manche</h1>
    <ErrorBox message={error} />
    <form method="post" action={`/competitions/${c.id}/tasks`} enctype="multipart/form-data" class="card">
      <div class="grid">
        <div>
          <label>Numéro</label>
          <input type="number" name="number" min="1" value={String(number)} required />
        </div>
        <div>
          <label>Date</label>
          <input type="date" name="date" value={date ?? ""} />
        </div>
      </div>
      <h2 class="mt"><Ic n="map" c="teal" />Définition de la manche</h2>
      <p class="small muted">Une seule des trois sources suffit.</p>
      <div class="grid">
        <div>
          <label>Fichier XCTrack (.xctsk)</label>
          <input type="file" name="xctsk" accept=".xctsk,.json,.txt" />
        </div>
        <div>
          <label>Image du QR code (PNG ou JPEG)</label>
          <input type="file" name="qr" accept="image/png,image/jpeg" />
        </div>
      </div>
      <label class="mt">Ou texte du QR code (commence par XCTSK:)</label>
      <textarea name="text" placeholder="XCTSK:{...}"></textarea>
      <p class="mt">
        <button class="primary">
          <Bi n="plus" />
          Créer la manche
        </button>
      </p>
    </form>
  </Layout>
);

const ROLE: Record<string, string> = { takeoff: "Décollage", sss: "Départ (SSS)", turnpoint: "Balise", ess: "ESS", goal: "Goal" };

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
  running: boolean;
  error?: string | null;
  notice?: string | null;
}> = ({ user, c, t, task, settings, distances, tracks, history, decisions, geometry, run, running, error, notice }) => {
  const tz = settings.timeZone;
  const loc = (hms?: string) => (hms ? utcHmsToLocal(hms, t.date, tz) : "");
  const results = run?.status === "done" && run.results ? (JSON.parse(run.results) as TaskScoring) : null;
  // Traces modifiées après le lancement du dernier calcul : le classement affiché n'en tient pas compte.
  const lastChange = Math.max(0, ...tracks.map((x) => x.uploaded_at), ...history.map((h) => h.ended_at), t.scoring_changed_at ?? 0);
  const stale = results !== null && run !== null && lastChange > run.started_at;
  const versions = new Map<string, number>();
  for (const h of history) versions.set(h.pilot_key, (versions.get(h.pilot_key) ?? 0) + 1);
  const when = (ms: number) => `${new Date(ms).toLocaleDateString("fr-FR", { timeZone: tz, day: "2-digit", month: "2-digit" })} ${localTime(ms, tz)}`;
  const fileUrl = (sha: string) => `/tasks/${t.id}/files/${sha}`;
  return (
    <Layout title={`Manche ${t.number} · ${c.name}`} user={user}>
      <div class="crumbs">
        <a href="/">Mes compétitions</a> › <a href={`/competitions/${c.id}`}>{c.name}</a>
      </div>
      <h1>
        Manche {t.number}
        {t.date ? <span class="muted"> · {dateRange(t.date, null)}</span> : null}
      </h1>
      <ErrorBox message={error} />
      {notice ? <div class="note">{notice}</div> : null}

      <div class="card">
        <h2><Ic n="map" c="teal" />Définition</h2>
        <div id="task-map" class="task-map" />
        <p class="small muted legend">
          <span style="color:#16a34a">● départ</span> <span style="color:#2563eb">● balise</span> <span style="color:#9333ea">● ESS</span>{" "}
          <span style="color:#dc2626">● goal</span> · trait noir : route optimisée (distance de la manche), longueur de chaque branche
        </p>
        <p class="small muted">
          {task.type === "race" ? "Race to goal" : "Time trial"} · portes {task.startGates.map(loc).join(", ") || "aucune"} · deadline{" "}
          {loc(task.deadline) || "aucune"} · heures locales ({tz})
        </p>
        <p class="small">
          Manche <strong>{km(distances.task)} km</strong> · décollage → ESS {km(distances.launchToEss)} km · section de vitesse{" "}
          {km(distances.speedSection)} km
        </p>
        <details class="fold" id="task-settings">
          <summary>Balises et réglages de la manche</summary>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Rôle</th>
                <th>Balise</th>
                <th class="n">Rayon</th>
                <th class="n">Altitude</th>
              </tr>
            </thead>
            <tbody>
              {task.turnpoints.map((tp, i) => (
                <tr>
                  <td>{i + 1}</td>
                  <td>{ROLE[tp.role] ?? tp.role}</td>
                  <td>{tp.zone.waypoint.name}</td>
                  <td class="n">{tp.zone.kind === "cylinder" ? `${km(tp.zone.radius, tp.zone.radius % 1000 ? 1 : 0)} km` : `ligne ${tp.zone.length} m`}</td>
                  <td class="n">{tp.zone.waypoint.altitude !== undefined ? `${tp.zone.waypoint.altitude} m` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form method="post" action={`/tasks/${t.id}`} class="grid mt">
          <div>
            <label>Date</label>
            <input type="date" name="date" value={t.date ?? ""} />
          </div>
          <div>
            <label>Manche arrêtée : heure d'annonce (locale)</label>
            <input type="text" name="stop" placeholder="HH:MM" value={loc(task.stopAnnouncement)} />
          </div>
          <div>
            <label>Leading Time Ratio (%)</label>
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
            <label>Pilotes présents (sauf ABS)</label>
            <input type="number" step="1" min="0" name="pilotsPresent" placeholder="pilotes qui ont volé" value={task.pilotsPresent ?? ""} />
          </div>
          <div>
            <label>Fin de manche pour le leading (locale)</label>
            <input type="text" name="taskEndTime" placeholder="dernier posé" value={loc(task.taskEndTime)} />
          </div>
          <div style="align-self:end">
            <button>
              <Bi n="save" />
              Enregistrer
            </button>
          </div>
        </form>
        </details>
      </div>

      <div class="card">
        <h2><Ic n="pulse" c="green" />Traces ({tracks.length})</h2>
        <form method="post" action={`/tasks/${t.id}/tracks`} enctype="multipart/form-data" class="row upload">
          <input type="file" name="files" accept=".igc,.zip" multiple required />
          <button>
            <Bi n="upload" />
            Envoyer
          </button>
          <span class="small muted">
            Fichiers IGC ou archive .zip. Le pilote est reconnu au numéro en fin de nom de fichier ; une trace envoyée pour un pilote
            qui en a déjà une la remplace. Pour un fichier nommé autrement, utilisez « Remplacer » sur la ligne du pilote.
          </span>
        </form>
        {tracks.length ? (
          <details class="mt">
            <summary>Voir les traces</summary>
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Pilote</th>
                    <th>Nom</th>
                    <th>Fichier</th>
                    <th>Reçu</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((tr) => (
                    <tr>
                      <td>{tr.pilot_key}</td>
                      <td>
                        <a href={`/tasks/${t.id}/pilots/${encodeURIComponent(tr.pilot_key)}`}>{tr.pilot_name ?? tr.pilot_key}</a>
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
                          <summary>Remplacer</summary>
                          <form method="post" action={`/tasks/${t.id}/tracks/${tr.id}/replace`} enctype="multipart/form-data" class="upload">
                            <input type="file" name="file" accept=".igc,.zip" required />
                            <input type="text" name="note" placeholder="Raison (facultatif) : trace reçue après coup, autre instrument…" maxlength={500} />
                            <button>
                              <Bi n="refresh" />
                              Remplacer la trace
                            </button>
                          </form>
                        </details>
                        <form method="post" action={`/tasks/${t.id}/tracks/${tr.id}/delete`}>
                          <button class="link">Retirer</button>
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
            <summary>Anciennes versions ({history.length})</summary>
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Pilote</th>
                    <th>Fichier</th>
                    <th>Reçu</th>
                    <th>Fin</th>
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
                        · <a href={`/tasks/${t.id}/pilots/${encodeURIComponent(h.pilot_key)}?v=${h.sha256}`}>voir</a>
                        {h.note ? <div class="small muted">{h.note}</div> : null}
                      </td>
                      <td class="small muted">
                        {when(h.uploaded_at)}
                        {h.uploaded_by_name ? ` · ${h.uploaded_by_name}` : ""}
                      </td>
                      <td class="small">
                        {h.ended_how === "replaced" ? "Remplacée" : "Retirée"} le {when(h.ended_at)}
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
        <RunCard t={t} run={run} running={running} settings={settings} tracks={tracks.length} stale={stale} />
      </div>

      <details class="card fold" id="decisions">
        <summary>
          <h2><Ic n="gavel" c="pink" />Décisions de l'organisateur ({decisions.length})</h2>
        </summary>
        <p class="small muted">
          Bonus (aide à un pilote accidenté…), pénalités, goal accordé après réclamation, pilotes absents ou restés au sol. Elles
          s'appliquent au prochain calcul ; le motif apparaît dans les résultats.
        </p>
        {decisions.length ? (
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Pilote</th>
                  <th>Nom</th>
                  <th>Décision</th>
                  <th>Motif</th>
                  <th>Saisie</th>
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
                      <form method="post" action={`/tasks/${t.id}/decisions/${d.id}/delete`}>
                        <button class="link" onclick="return confirm('Supprimer cette décision ?')">Supprimer</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <form method="post" action={`/tasks/${t.id}/decisions`} class="grid mt">
          <div>
            <label>Pilote (numéro)</label>
            <input type="text" name="pilot" list="pilot-keys" required />
            <datalist id="pilot-keys">
              {tracks.map((x) => (
                <option value={x.pilot_key}>{x.pilot_name ?? ""}</option>
              ))}
            </datalist>
          </div>
          <div>
            <label>Nom (pilote sans trace)</label>
            <input type="text" name="name" />
          </div>
          <div>
            <label>Décision</label>
            <select name="kind">
              {Object.entries(DECISION_KINDS).map(([k, v]) => (
                <option value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Valeur (points ou %)</label>
            <input type="number" step="any" min="0" name="value" placeholder="bonus, pénalité" />
          </div>
          <div style="grid-column:span 2">
            <label>Motif</label>
            <input type="text" name="reason" required placeholder="Aide à un pilote accidenté" />
          </div>
          <div style="align-self:end">
            <button>
              <Bi n="plus" />
              Ajouter
            </button>
          </div>
        </form>
      </details>

      <link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
      <script type="application/json" id="task-geometry" dangerouslySetInnerHTML={{ __html: geometry.replace(/</g, "\\u003c") }} />
      <script src="/vendor/leaflet/leaflet.js" />
      <script src="/static/basemaps.js" />
      <script src="/static/taskmap.js" />
      <script src="/static/run.js" />
    </Layout>
  );
};

/** Bloc « Calcul » : bouton, avancement ou bilan, classement. Rechargé seul par /static/run.js. */
export const RunCard: FC<{ t: TaskRow; run: RunRow | null; running: boolean; settings: CompetitionSettings; tracks: number; stale: boolean }> = ({
  t,
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
        <h2><Ic n="calc" c="blue" />Calcul</h2>
        <form method="post" action={`/tasks/${t.id}/runs`} id="run-form">
          <button class="primary" disabled={running || !tracks}>
            {running ? <span class="spin" /> : <Bi n="play" />}
            {running ? "Calcul en cours…" : "Lancer le calcul"}
          </button>
        </form>
      </div>
      <RunStatus run={run} tz={tz} taskId={t.id} />
      {stale && !running && results ? (
        <div class="note">Des traces, réglages ou décisions ont changé depuis ce calcul : relancez-le pour mettre le classement à jour.</div>
      ) : null}
      {results ? <Results r={results} tz={tz} settings={settings} taskId={t.id} /> : null}
    </>
  );
};

const RunStatus: FC<{ run: RunRow | null; tz: string; taskId: number }> = ({ run, tz, taskId }) => {
  if (!run) return <p class="muted">Aucun calcul pour l'instant.</p>;
  const when = new Date(run.started_at).toLocaleString("fr-FR", { timeZone: tz, dateStyle: "short", timeStyle: "short" });
  if (run.status === "queued" || run.status === "running")
    // Rempli et mis à jour par /static/run.js.
    return (
      <div id="run-live" data-url={`/tasks/${taskId}/run.json`}>
        <p>
          <span class="spin" /> Calcul en cours… {run.done} / {run.total} traces
        </p>
      </div>
    );
  if (run.status === "error") return <div class="err">Le calcul a échoué : {run.error}</div>;
  const secs = run.finished_at ? Math.round((run.finished_at - run.started_at) / 1000) : null;
  return (
    <p class="small muted">
      Calcul du {when}, {run.total} traces{secs !== null ? `, en ${secs} s` : ""}.
    </p>
  );
};

const penalty = (p: PilotResult) =>
  p.airspacePenalty?.points !== undefined
    ? `−${p.airspacePenalty.points.toFixed(1)} pts`
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
      ...(kinds.includes("penalty") && p.airspacePenalty ? [`Espace aérien : ${penalty(p)}`] : []),
    ].join("\n");
  const bonus = d.some((x) => x.kind === "bonus");
  const pen = d.some((x) => x.kind === "penalty" || x.kind === "penalty-percent") || Boolean(p.airspacePenalty);
  return (
    <>
      {bonus ? (
        <>
          {" "}
          <span class="chip t-bonus" title={why(["bonus"])}>
            bonus
          </span>
        </>
      ) : null}
      {pen ? (
        <>
          {" "}
          <span class="chip t-pen" title={why(["penalty", "penalty-percent"])}>
            pénalité
          </span>
        </>
      ) : null}
      {d.some((x) => x.kind === "goal") ? (
        <>
          {" "}
          <span class="chip t-dec" title={why(["goal"])}>
            accordé
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
  if (kind === "bonus") return `Bonus ${v.toLocaleString("fr-FR")} pts`;
  if (kind === "penalty") return `Pénalité ${v.toLocaleString("fr-FR")} pts`;
  if (kind === "penalty-percent") return `Pénalité ${v.toLocaleString("fr-FR")} %`;
  return k.label;
}

function remark(p: PilotResult, tz: string): string {
  const decided = (p.decisions ?? []).map((d) => `${decisionLabel(d.kind, d.value)} : ${d.reason}`);
  const control = controlRemark(p, tz);
  return [...decided, control].filter(Boolean).join(" · ");
}

function controlRemark(p: PilotResult, tz: string): string {
  if (p.status === "GOAL" || p.status === "ABS" || p.status === "DNF" || p.error) return p.error ?? "";
  const a = (p.approaches ?? []).find((x) => !x.reached);
  // Au-delà de 500 m, c'est un posé normal, pas une zone frôlée.
  if (!a?.closest || Math.abs(a.closest.distance) > 500) return "";
  const d = a.closest.distance;
  const what = a.role === "sss" ? "Départ manqué" : `${a.name} manquée`;
  return `${what} de ${Math.abs(d).toFixed(0)} m (${d >= 0 ? "dehors" : "dedans"}) à ${localTime(a.closest.time, tz)}`;
}

const fr = (v: number, digits: number) => v.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pts = (v: number | null | undefined) => (v === null || v === undefined ? "" : fr(v, 1));

/** Validité de la manche et répartition des points (S7F 10 et 11). */
const GapSummary: FC<{ r: TaskScoring; settings: CompetitionSettings }> = ({ r, settings }) => {
  const g = r.gap;
  const v = g.validity;
  const winner = Math.max(0, ...r.pilots.map((p) => p.total ?? 0));
  return (
    <div class="gap">
      <div>
        <div class="muted small">Validité de la manche</div>
        <div class="big">{fr(v.task, 4)}</div>
        <div class="small">
          décollage {fr(v.launch, 3)} × distance {fr(v.distance, 3)} × temps {fr(v.time, 3)}
          {v.stopped !== null ? ` × arrêt ${fr(v.stopped, 3)}` : ""}
        </div>
        <div class="small">
          <strong>validité FTV {fr(winner / 10, 1)} %</strong> (vainqueur {pts(winner)} / 1000), celle du classement général
        </div>
      </div>
      <div>
        <div class="muted small">Points disponibles</div>
        <div class="big">{fr(g.available.distance + g.available.time + g.available.leading + g.available.arrival, 1)}</div>
        <div class="small">
          distance {pts(g.available.distance)} · temps {pts(g.available.time)} · leading {pts(g.available.leading)}
          {g.timePointsReduction ? ` (dont ${pts(g.timePointsReduction)} repris au temps, manche arrêtée)` : ""}
        </div>
      </div>
      <div>
        <div class="muted small">Pilotes</div>
        <div class="big">{g.pilotsFlying}</div>
        <div class="small">
          volants sur {g.pilotsPresent} présents · {g.pilotsEss} à l'ESS · {g.pilotsGoal} au goal (ratio {fr(g.goalRatio, 3)})
        </div>
      </div>
      <div>
        <div class="muted small">Formule</div>
        <div class="big">{GAP_PROFILES[settings.gapProfile].split(" (")[0]}</div>
        <div class="small">
          LTR {fr(g.leadingTimeRatio * 100, g.leadingTimeRatio * 100 % 1 ? 2 : 0)} % · meilleur temps {duration(g.bestTime)} · meilleure distance{" "}
          {km(g.bestDistance)} km
        </div>
      </div>
    </div>
  );
};

const Results: FC<{ r: TaskScoring; tz: string; settings: CompetitionSettings; taskId: number }> = ({ r, tz, settings, taskId }) => {
  const stopped = r.pilots.some((p) => p.stop);
  const counts = (s: string) => r.pilots.filter((p) => p.status === s).length;
  // Calcul fait avant l'arrivée des points GAP : il faut le relancer.
  const withPoints = Boolean(r.gap);
  const leadWarn = r.pilots.filter((p) => p.leadingWarnings?.length).length;
  return (
    <>
      {withPoints ? <GapSummary r={r} settings={settings} /> : <div class="note">Ce calcul date d'avant les points GAP : relancez-le pour les obtenir.</div>}
      <p class="small">
        {counts("GOAL")} au goal · {counts("ESS")} à l'ESS sans goal · {counts("DF")} posés · {counts("MIND")} à la distance minimale
        {counts("ERREUR") ? ` · ${counts("ERREUR")} traces en erreur` : ""}
        {counts("DNF") ? ` · ${counts("DNF")} restés au sol` : ""}
        {counts("ABS") ? ` · ${counts("ABS")} absents` : ""}
        {leadWarn ? (
          <>
            {" "}
            · <span class="lead-warn">⚠</span> {leadWarn} trace{leadWarn > 1 ? "s" : ""} au leading peut-être faussé (trou, points espacés ou arrêt avant l'atterrissage : survolez l'icône)
          </>
        ) : null}{" "}
        · leading {LEADING_PROFILES[settings.leadingProfile]} ·{" "}
        <a href={`/tasks/${taskId}/results.csv`}>exporter en CSV</a>
      </p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="n">#</th>
              <th>Pilote</th>
              <th>Nom</th>
              <th>Statut</th>
              {withPoints ? <th class="n">Total</th> : null}
              <th>Départ</th>
              <th>ESS</th>
              <th class="n">Temps</th>
              <th class="n">Distance</th>
              {stopped ? <th class="n">Alt. à l'arrêt</th> : null}
              <th class="n">LC</th>
              {withPoints ? (
                <>
                  <th class="n">Pts distance</th>
                  <th class="n">Pts temps</th>
                  <th class="n">Pts leading</th>
                  <th class="n">Pénalité</th>
                </>
              ) : (
                <th class="n">Leading</th>
              )}
              <th>Espace aérien</th>
              <th>Remarque</th>
            </tr>
          </thead>
          <tbody>
            {r.pilots.map((p, i) => (
              <tr>
                <td class="n">{i + 1}</td>
                <td>{p.id}</td>
                <td>{p.fixes ? <a href={`/tasks/${taskId}/pilots/${encodeURIComponent(p.id)}`}>{p.name}</a> : p.name}</td>
                <td>
                  <span class={`chip s-${p.status}`} title={p.error ?? ""}>
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
                    <span class="lead-warn" title={`Leading peut-être faussé : ${p.leadingWarnings.join(", ")}`}>
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
      {r.pilots.some((p) => p.error) ? (
        <ul class="small">
          {r.pilots
            .filter((p) => p.error)
            .map((p) => (
              <li>
                {p.id} : {p.error}
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
    (p.leadingWarnings ?? []).join(" | "),
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
  t,
  pilotKey,
  pilotName,
  data,
}) => (
  <Layout title={`${pilotName} · manche ${t.number}`} user={user}>
    <link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
    <style dangerouslySetInnerHTML={{ __html: VIEWER_CSS }} />
    <div class="crumbs">
      <a href="/">Mes compétitions</a> › <a href={`/competitions/${c.id}`}>{c.name}</a> › <a href={`/tasks/${t.id}`}>Manche {t.number}</a>
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
  <Layout title="Introuvable" user={user ?? null}>
    <h1>Page introuvable</h1>
    <p>
      <a href="/">Retour à mes compétitions</a>
    </p>
  </Layout>
);

export type { Child };
