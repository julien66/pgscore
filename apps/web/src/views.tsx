import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { PilotResult, Task, TaskScoring } from "@pgscore/engine";
import type { CompetitionRow, RunRow, TaskRow, TrackHistoryRow, TrackRow, User } from "./db.js";
import { LEADING_PROFILES, PENALTY_RULES, type CompetitionSettings } from "./settings.js";
import { duration, km, localTime, utcHmsToLocal } from "./time.js";

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#5d6678;--line:#dde1e8;--accent:#1f6feb;--accent-ink:#fff;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--chip:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--text:#e6e9ef;--muted:#9aa3b2;--line:#2a303b;--accent:#4c8dff;--accent-ink:#0b0e13;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--chip:#222833}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line)}
header .in{max-width:1200px;margin:0 auto;padding:10px 16px;display:flex;gap:16px;align-items:center}
header .brand{font-weight:700;font-size:17px;color:var(--text)}header .sp{flex:1}header .who{color:var(--muted);font-size:14px}
main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:24px;margin:4px 0 16px}h2{font-size:18px;margin:0 0 12px}
.crumbs{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:3px}
input[type=text],input[type=number],input[type=date],input[type=email],select,textarea{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);font:inherit}
textarea{font-family:ui-monospace,Menlo,monospace;font-size:12px;min-height:70px}
.check{display:flex;gap:8px;align-items:center;color:var(--text);font-size:14px}
button,.btn{display:inline-block;padding:8px 14px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;cursor:pointer}
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
.center{max-width:420px;margin:60px auto;text-align:center}
`;

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
            {p.label}
          </a>
        </p>
      ))}
      {!providers.length && !devLogin ? (
        <div class="note">Aucun service de connexion n'est configuré (variables GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET).</div>
      ) : null}
      {devLogin ? (
        <form method="post" action="/auth/dev" class="card mt" style="text-align:left">
          <h2>Connexion de développement</h2>
          <p class="small muted">Active seulement avec DEV_LOGIN=1, pour tester sans Google.</p>
          <label>E-mail</label>
          <input type="email" name="email" required value="dev@pgscore.local" />
          <label class="mt">Nom</label>
          <input type="text" name="name" value="Organisateur test" />
          <p>
            <button class="primary">Entrer</button>
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
      <h2 class="mt">Paramètres de la formule (S7F, chapitre 5)</h2>
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
      <h2 class="mt">Espace aérien</h2>
      <label>Fichier OpenAir (facultatif, modifiable ensuite)</label>
      <input type="file" name="airspace" accept=".txt,.air,.openair" />
      <p class="mt">
        <button class="primary">Créer la compétition</button>
      </p>
    </form>
  </Layout>
);

export const CompetitionPage: FC<{
  user: User;
  c: CompetitionRow;
  v: CompetitionFormValues;
  tasks: TaskRow[];
  airspaceCount: number | null;
  error?: string | null;
  notice?: string | null;
}> = ({ user, c, v, tasks, airspaceCount, error, notice }) => (
  <Layout title={c.name} user={user}>
    <div class="crumbs">
      <a href="/">Mes compétitions</a>
    </div>
    <h1>{c.name}</h1>
    <ErrorBox message={error} />
    {notice ? <div class="note">{notice}</div> : null}

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>Manches</h2>
        <a class="btn primary" href={`/competitions/${c.id}/tasks/new`}>
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
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="muted">Pas encore de manche.</p>
      )}
    </div>

    <div class="card">
      <h2>Espace aérien</h2>
      {c.airspace_name ? (
        <p>
          <strong>{c.airspace_name}</strong> · {airspaceCount} zone{airspaceCount === 1 ? "" : "s"}
        </p>
      ) : (
        <p class="muted">Aucun fichier : les traces ne sont pas contrôlées pour l'espace aérien.</p>
      )}
      <form method="post" action={`/competitions/${c.id}/airspace`} enctype="multipart/form-data" class="row">
        <input type="file" name="airspace" accept=".txt,.air,.openair" required />
        <button>{c.airspace_name ? "Remplacer" : "Envoyer"}</button>
      </form>
      <p class="small muted">Limites lues en AMSL ; niveaux de vol convertis à 1013,25 hPa puis abaissés de 100 m. Les limites AGL sont ignorées.</p>
    </div>

    <form method="post" action={`/competitions/${c.id}`} class="card">
      <h2>Compétition</h2>
      <CompetitionFields v={v} />
      <p class="mt">
        <button class="primary">Enregistrer</button>
      </p>
    </form>
  </Layout>
);

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
      <h2 class="mt">Définition de la manche</h2>
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
        <button class="primary">Créer la manche</button>
      </p>
    </form>
  </Layout>
);

const ROLE: Record<string, string> = { takeoff: "Décollage", sss: "Départ (SSS)", turnpoint: "Balise", ess: "ESS", goal: "Goal" };

export const TaskPage: FC<{
  user: User;
  c: CompetitionRow;
  t: TaskRow;
  task: Task;
  settings: CompetitionSettings;
  distances: { task: number; launchToEss: number; speedSection: number };
  tracks: TrackRow[];
  history: TrackHistoryRow[];
  /** Dessin de la manche (JSON de taskGeometry). */
  geometry: string;
  run: RunRow | null;
  running: boolean;
  error?: string | null;
  notice?: string | null;
}> = ({ user, c, t, task, settings, distances, tracks, history, geometry, run, running, error, notice }) => {
  const tz = settings.timeZone;
  const loc = (hms?: string) => (hms ? utcHmsToLocal(hms, t.date, tz) : "");
  const results = run?.status === "done" && run.results ? (JSON.parse(run.results) as TaskScoring) : null;
  // Traces modifiées après le lancement du dernier calcul : le classement affiché n'en tient pas compte.
  const lastChange = Math.max(0, ...tracks.map((x) => x.uploaded_at), ...history.map((h) => h.ended_at));
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
        <h2>Définition</h2>
        <div id="task-map" class="task-map" />
        <p class="small muted legend">
          <span style="color:#16a34a">● départ</span> <span style="color:#2563eb">● balise</span> <span style="color:#9333ea">● ESS</span>{" "}
          <span style="color:#dc2626">● goal</span> · trait noir : route optimisée (distance de la manche), longueur de chaque branche
        </p>
        <p class="small muted">
          {task.type === "race" ? "Race to goal" : "Time trial"} · portes {task.startGates.map(loc).join(", ") || "aucune"} · deadline{" "}
          {loc(task.deadline) || "aucune"} · heures locales ({tz})
        </p>
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
        <p class="small">
          Manche <strong>{km(distances.task)} km</strong> · décollage → ESS {km(distances.launchToEss)} km · section de vitesse{" "}
          {km(distances.speedSection)} km
        </p>
        <form method="post" action={`/tasks/${t.id}`} class="grid mt">
          <div>
            <label>Date</label>
            <input type="date" name="date" value={t.date ?? ""} />
          </div>
          <div>
            <label>Manche arrêtée : heure d'annonce (locale)</label>
            <input type="text" name="stop" placeholder="HH:MM" value={loc(task.stopAnnouncement)} />
          </div>
          <div style="align-self:end">
            <button>Enregistrer</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Traces ({tracks.length})</h2>
        <form method="post" action={`/tasks/${t.id}/tracks`} enctype="multipart/form-data" class="row upload">
          <input type="file" name="files" accept=".igc,.zip" multiple required />
          <button>Envoyer</button>
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
                            <button>Remplacer la trace</button>
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

      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h2>Calcul</h2>
          <form method="post" action={`/tasks/${t.id}/runs`} id="run-form">
            <button class="primary" disabled={running || !tracks.length}>
              {running ? "Calcul en cours…" : "Lancer le calcul"}
            </button>
          </form>
        </div>
        <RunStatus run={run} tz={tz} taskId={t.id} />
        {stale && !running ? (
          <div class="note">Des traces ont changé depuis ce calcul : relancez-le pour mettre le classement à jour.</div>
        ) : null}
        {results ? <Results r={results} tz={tz} settings={settings} taskId={t.id} /> : null}
      </div>
      <link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
      <script type="application/json" id="task-geometry" dangerouslySetInnerHTML={{ __html: geometry.replace(/</g, "\\u003c") }} />
      <script src="/vendor/leaflet/leaflet.js" />
      <script src="/static/taskmap.js" />
      <script src="/static/run.js" />
    </Layout>
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
      Calcul du {when}, {run.total} traces{secs !== null ? `, en ${secs} s` : ""}. Classement provisoire : contrôle et leading, sans les points GAP
      (à venir).
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
function remark(p: PilotResult, tz: string): string {
  if (p.status === "GOAL" || p.error) return p.error ?? "";
  const a = (p.approaches ?? []).find((x) => !x.reached);
  // Au-delà de 500 m, c'est un posé normal, pas une zone frôlée.
  if (!a?.closest || Math.abs(a.closest.distance) > 500) return "";
  const d = a.closest.distance;
  const what = a.role === "sss" ? "Départ manqué" : `${a.name} manquée`;
  return `${what} de ${Math.abs(d).toFixed(0)} m (${d >= 0 ? "dehors" : "dedans"}) à ${localTime(a.closest.time, tz)}`;
}

const Results: FC<{ r: TaskScoring; tz: string; settings: CompetitionSettings; taskId: number }> = ({ r, tz, settings, taskId }) => {
  const stopped = r.pilots.some((p) => p.stop);
  const counts = (s: string) => r.pilots.filter((p) => p.status === s).length;
  return (
    <>
      <p class="small">
        {counts("GOAL")} au goal · {counts("ESS")} à l'ESS sans goal · {counts("DF")} posés · {counts("MIND")} à la distance minimale
        {counts("ERREUR") ? ` · ${counts("ERREUR")} traces en erreur` : ""} · leading {LEADING_PROFILES[settings.leadingProfile]} ·{" "}
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
              <th>Départ</th>
              <th>ESS</th>
              <th class="n">Temps</th>
              <th class="n">Distance</th>
              {stopped ? <th class="n">Alt. à l'arrêt</th> : null}
              <th class="n">LC</th>
              <th class="n">Leading</th>
              <th>Espace aérien</th>
              <th>Remarque</th>
            </tr>
          </thead>
          <tbody>
            {r.pilots.map((p, i) => (
              <tr>
                <td class="n">{i + 1}</td>
                <td>{p.id}</td>
                <td>
                  <a href={`/tasks/${taskId}/pilots/${encodeURIComponent(p.id)}`}>{p.name}</a>
                </td>
                <td>
                  <span class={`chip s-${p.status}`} title={p.error ?? ""}>
                    {p.status}
                  </span>
                </td>
                <td>{localTime(p.startTime, tz)}</td>
                <td>{localTime(p.essTime, tz)}</td>
                <td class="n">{duration(p.speedSectionTime)}</td>
                <td class="n">{km(p.distance)} km</td>
                {stopped ? <td class="n">{p.stop?.flying ? `${Math.round(p.stop.altitudeAboveGoal)} m` : ""}</td> : null}
                <td class="n">{p.leadingCoefficient !== null ? p.leadingCoefficient.toFixed(4) : ""}</td>
                <td class="n">{p.leadingFactor !== null ? p.leadingFactor.toFixed(3) : ""}</td>
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
  const head = ["rang", "pilote", "nom", "statut", "depart", "ess", "temps_s", "distance_km", "alt_arret_m", "lc", "leading", "espace_aerien", "profondeur_m", "penalite"];
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
    p.airspace.map((a) => a.name).join(" | "),
    p.airspace.length ? Math.max(...p.airspace.map((a) => a.depth)).toFixed(1) : "",
    penalty(p),
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
