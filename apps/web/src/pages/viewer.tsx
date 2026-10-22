import type { FC } from "hono/jsx";
import type { CompetitionRow, TaskRow, User } from "../db.js";
import { t } from "../i18n.js";
import { Layout } from "./layout.js";

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

export const ViewerPage: FC<{ user: User | null; c: CompetitionRow; t: TaskRow; pilotKey: string; pilotName: string; data: string }> = ({
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
      <a href="/">{t("Compétitions")}</a> › <a href={`/competitions/${c.id}`}>{c.name}</a> › <a href={`/tasks/${tk.id}`}>{t("Manche {n}", { n: tk.number })}</a>
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
