import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { GAP_RULES, NOMINAL_GOAL, NOMINAL_LAUNCH, speedFraction, type DecisionKind, type LeadingWarning, type PilotResult, type Task, type TaskScoring } from "@pgscore/engine";
import type { ApiTokenRow } from "./auth.js";
import type { CompetitionRow, DecisionRow, PilotRow, RunRow, TaskRow, TrackHistoryRow, TrackRow, User } from "./db.js";
import { DECISION_KINDS } from "./decisions.js";
import { GAP_PROFILES, PENALTY_RULES, type CompetitionSettings, type StoredTask } from "./settings.js";
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
header .brand{font-weight:700;font-size:17px;color:var(--text);display:inline-flex;align-items:center;gap:9px}header .sp{flex:1}header .who{color:var(--muted);font-size:14px}header .login{font-size:14px;font-weight:600;display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--text)}header .login:hover{border-color:var(--accent)}.gg{flex:none}a.btn.gbtn{background:#fff;color:#1f1f1f;border:1px solid #747775;font-weight:600;gap:10px;padding:10px 16px}a.btn.gbtn:hover{background:#f6f8fc}header a.who:hover{color:var(--accent)}footer{max-width:1200px;margin:0 auto;padding:0 16px 30px;color:var(--muted);font-size:13px;text-align:center}footer a{color:var(--muted)}footer a:hover{color:var(--accent)}@media print{footer{display:none}}.about{max-width:960px}.about-title{display:flex;align-items:center;gap:14px}.about .card h2{margin-top:0}.about .lead{font-size:17px;line-height:1.55}.about h2{margin-top:22px}.about ul{padding-left:20px;line-height:1.6}.about .pill2{display:flex;gap:12px;flex-wrap:wrap}.about .pill2>div{flex:1 1 300px}pre.code{background:var(--chip);padding:8px 10px;border-radius:7px;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.doc h2{margin-top:18px}
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
button.danger{background:var(--bad);border-color:var(--bad);color:#fff;font-weight:600}.card.danger{border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
button.link{border:0;background:none;color:var(--muted);padding:0;font-size:13px}a.act{display:inline-flex;align-items:center;gap:7px;color:var(--muted);font-size:13px}a.act:hover,button.link.print-rk:hover{color:var(--accent);text-decoration:none}a.act .bi{color:#21a366}.acts{display:inline-flex;gap:16px;align-items:center;flex-wrap:wrap;margin-right:8px;vertical-align:middle}body.printing .print-me .acts,body.printing a.act{display:none!important}
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
.list li.task{flex-wrap:wrap;row-gap:2px}.list .task-rk{flex-basis:100%;color:var(--muted)}.list form.official{margin-left:auto}.list form.official .check{color:var(--muted)}
.list.runs li{display:block}.list.runs .bar{margin-top:6px}
.lead-warn{color:var(--warn);cursor:help;margin-right:4px}
table.pilots td{padding:3px 4px}table.pilots input[type=text],table.pilots select{padding:4px 6px;font-size:13px}
table.pilots .in-s{width:72px}table.pilots .in-m{width:120px}table.pilots .in-l{width:190px}table.pilots tr.new td{background:var(--chip)}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 12px;border-bottom:1px solid var(--line)}.tabs a{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;color:var(--muted)}.tabs a.on{background:var(--card);border-color:var(--line);color:var(--text);font-weight:600;margin-bottom:-1px}
[data-swap].loading{opacity:.55;transition:opacity .15s}
.tabs a.tab-end,.tabs form.tab-end{margin-left:auto}
.tabs form.tab-end{align-self:center}
.tabs .task-tabs{display:flex;gap:2px;margin-left:auto;align-self:flex-end}.tabs .task-tabs a{padding:6px 10px}
table.rk.sport-hidden .sp{display:none}.sp-toggle .sp-open{display:none}html.sport-open .sp-toggle .sp-open{display:inline}html.sport-open .sp-toggle .sp-closed{display:none}.rk-bar{display:flex;justify-content:flex-end;align-items:center;gap:8px 16px;flex-wrap:wrap;margin:4px 0}.rk-bar .acts{margin-right:auto}
@page{size:A4 portrait;margin:8mm}
.print-head{display:none}
body.printing{background:#fff;color:#000;font-size:10px}body.printing header,body.printing .no-print,body.printing .print-me nav.tabs,body.printing .print-me h2,body.printing .print-me .note,body.printing .print-me .print-rk,body.printing .print-me .rk-bar{display:none!important}
body.printing main{max-width:none;width:194mm;padding:0;margin:0}body.printing .print-me{border:0;padding:0;margin:0;background:none}
body.printing .print-head{display:block;margin:0 0 6px}body.printing .print-head strong{font-size:14px}body.printing .print-head span{color:#555;margin-left:8px}
body.printing .print-me>p{font-size:8px;margin:2px 0}body.printing .scroll{overflow:visible}body.printing table.rk{width:auto;font-size:8px;color:#000}body.printing table.rk th,body.printing table.rk td{padding:1.5px 3px;border-color:#ccc}
body.printing table.rk th{font-size:7px;color:#333}body.printing table.rk .sp{display:table-cell!important}body.printing table.rk a{color:#000}
body.printing table.rk td.small,body.printing table.rk td.small *{font-size:7px}body.printing table.rk td.sponsor{min-width:30mm;max-width:40mm}body.printing table.rk td.gear{white-space:nowrap}body.printing table.rk .muted,body.printing table.rk .sub{color:#555}
body.printing table.rk tr{break-inside:avoid}body.printing table.rk thead{display:table-header-group}
@media print{header,.print-rk,a.act,.acts,.rk-bar{display:none}.card{border:0}.scroll{overflow:visible}}
td.gear{line-height:1.25}table td.sponsor{white-space:normal;min-width:160px;max-width:260px;overflow-wrap:anywhere;line-height:1.25}button.link.sp-toggle{font-size:13px;color:var(--accent)}
.details h3{font-size:16px;margin:22px 0 6px}.details ul{margin:4px 0 10px;padding-left:20px}
table.calc{margin:4px 0 8px}table.calc th{width:190px;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text);vertical-align:top}
table.calc td.how{white-space:normal;color:var(--muted);font-size:13px}table.calc td.val{width:110px;vertical-align:top;font-variant-numeric:tabular-nums}
.split{display:flex;height:22px;border-radius:6px;overflow:hidden;margin:8px 0;font-size:12px;color:#fff;font-weight:600}.split span{display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden}
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
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  sheet: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
  calc: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M8 6h8"/><path d="M16 14v4"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>',
  filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  play: '<path d="M6 3l14 9-14 9z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  userMinus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
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
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <script src="/static/i18n.js" />
    </head>
    <body>
      <header>
        <div class="in">
          <a class="brand" href="/">
            <img src="/logo.svg" alt="" width="26" height="26" />
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
              <a class="who" href="/account" title={t("Mon compte et clés d'API")}>{user.name ?? user.email}</a>
              <form method="post" action="/auth/logout">
                <button class="link">{t("Se déconnecter")}</button>
              </form>
            </>
          ) : (
            <a href="/login" class="login">
              <GoogleG />
              {t("Se connecter")}
            </a>
          )}
        </div>
      </header>
      <main>{children}</main>
      <footer>
        <a href="/about">{t("À propos de pgscore")}</a> · <a href="/api">{t("API")}</a> ·{" "}
        <a href="https://github.com/julien66/pgscore">{t("Logiciel libre, licence AGPL-3.0")}</a>
      </footer>
    </body>
  </html>
  </>
);

/** Logo « G » de Google, en couleurs (consignes de marque Google Sign-In). */
const GoogleG: FC = () => (
  <svg class="gg" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

export const ErrorBox: FC<{ message?: string | null }> = ({ message }) => (message ? <div class="err">{message}</div> : null);

export const LoginPage: FC<{ providers: Array<{ href: string; label: string }>; devLogin: boolean; error?: string | null }> = ({
  providers,
  devLogin,
  error,
}) => (
  <Layout title={t("Connexion")}>
    <div class="center">
      <img src="/logo.svg" alt="" width="72" height="72" />
      <h1>pgscore</h1>
      <p class="muted">{t("Contrôle et scoring des compétitions de parapente cross-country.")}</p>
      <ErrorBox message={error} />
      {providers.map((p) => (
        <p>
          <a class="btn gbtn" href={p.href}>
            <GoogleG />
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

type HomeComp = CompetitionRow & { owner?: string; scoredAt?: number };
const CompList: FC<{ list: HomeComp[] }> = ({ list }) => (
  <ul class="list">
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
}> = ({ user, c, v, tasks, board, pilots, airspaceCount, error, notice, edit, canEdit, canDelete, runs }) => (
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
        <CompetitionEdit c={c} v={v} pilots={pilots} airspaceCount={airspaceCount} open={Boolean(error)} />
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

/** Colonnes d'identité des classements (genre, nation, matériel, sponsor), affichées si le registre les renseigne. */
const identity = (registry: PilotRow[], keys: string[]) => {
  const reg = new Map(registry.map((p) => [p.pilot_key, p]));
  const of = (k: string) => reg.get(k);
  const glider = (x: PilotRow | undefined) => [x?.glider_brand, x?.glider_model].filter(Boolean).join(" ");
  const harness = (x: PilotRow | undefined) => [x?.harness_brand, x?.harness_model].filter(Boolean).join(" ");
  const gear = (x: PilotRow | undefined) => glider(x) || harness(x);
  const has = (f: (x: PilotRow | undefined) => unknown) => keys.some((k) => Boolean(f(of(k))));
  const show = { gender: has((x) => x?.gender), nation: has((x) => x?.nation), gear: has(gear), sponsor: has((x) => x?.sponsor) };
  const Head: FC = () => (
    <>
      {show.gender ? <th>{t("Genre")}</th> : null}
      {show.nation ? <th>{t("Nat.")}</th> : null}
      {show.gear ? <th>{t("Matériel")}</th> : null}
      {show.sponsor ? <th>{t("Sponsor")}</th> : null}
    </>
  );
  const Cells: FC<{ k: string }> = ({ k }) => {
    const x = of(k);
    return (
      <>
        {show.gender ? <td>{x?.gender ?? ""}</td> : null}
        {show.nation ? <td>{x?.nation ?? ""}</td> : null}
        {show.gear ? (
          <td class="small gear" title={x?.glider_class ?? ""}>
            {glider(x)}
            {harness(x) ? <div class="muted">{harness(x)}</div> : null}
          </td>
        ) : null}
        {show.sponsor ? <td class="small sponsor">{x?.sponsor ?? ""}</td> : null}
      </>
    );
  };
  return { Head, Cells };
};

/** Lien d'export CSV, présenté comme le bouton d'impression, avec une icône de tableur. */
const CsvLink: FC<{ href: string }> = ({ href }) => (
  <a class="act" href={href} title={t("Télécharger le tableau (CSV, ouvrable dans Excel)")}>
    <Bi n="sheet" /> {t("Exporter en CSV")}
  </a>
);

/** Bouton d'impression du classement affiché : détail déplié, ajusté à une page A4 portrait (competition.js). */
const PrintButton: FC = () => (
  <button type="button" class="link print-rk" title={t("Imprimer ou enregistrer en PDF (A4 portrait, détail déplié)")}>
    <Bi n="printer" /> {t("Imprimer / PDF")}
  </button>
);

/** Bascule version courte / version complète (colonnes .sp), posée en haut et en bas à droite du tableau. */
const SportToggle: FC<{ csv?: string }> = ({ csv }) => (
  <div class="rk-bar">
    {csv ? (
      <span class="acts">
        <CsvLink href={csv} />
        <PrintButton />
      </span>
    ) : null}
    <button type="button" class="link sp-toggle" title={t("Afficher ou masquer le détail sportif")}>
      <span class="sp-closed">{t("Version complète")}</span>
      <span class="sp-open">{t("Version courte")}</span>
    </button>
  </div>
);

const TotalHead: FC = () => <th class="n">{t("Total")}</th>;

export const StandingsTable: FC<{ c: CompetitionRow; s: Standings; limit?: number; rid?: number; registry?: PilotRow[] }> = ({ c, s, limit, rid, registry = [] }) => {
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
            <a class="swap" href={boardUrl(c, { r: rid, all: true })}>
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
    onsubmit={`return confirm(${JSON.stringify(t("Supprimer le classement « {name} » ? Le classement général n'est pas touché.", { name: t(name) }))})`}
  >
    <button class={big ? "danger" : "link"} title={t("Supprimer ce classement")}>
      <Bi n="trash" />
      {t("Supprimer ce classement")}
    </button>
  </form>
);

const RankingTabs: FC<{ c: CompetitionRow; rankings: Array<{ id: number; name: string; count?: number }>; current: number | null; create?: boolean; canEdit?: boolean }> = ({
  c,
  rankings,
  current,
  create,
  canEdit,
}) => (
  <nav class="tabs">
    <a href={boardUrl(c)} class={`swap${current === null && !create ? " on" : ""}`}>
      {t("Général")}
    </a>
    {rankings.map((r) => (
      <a href={boardUrl(c, { r: r.id })} class={`swap${current === r.id ? " on" : ""}`}>
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
  create: boolean;
  all: boolean;
  /** Créateur ou administrateur : création et réglage des classements, officialisation des manches. */
  canEdit: boolean;
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
  return (
    <>
      <RankingTabs c={c} rankings={rankings.map((x) => ({ id: x.r.row.id, name: x.r.row.name, count: x.count }))} current={current?.row.id ?? null} create={create} canEdit={b.canEdit} />
      <ErrorBox message={b.error} />
      {b.notice ? <div class="note">{b.notice}</div> : null}
      {create ? (
        <RankingForm c={c} r={null} />
      ) : (
        <>
          {current && !pilots.length && b.canEdit ? <p class="small muted">{t("Aucun pilote inscrit : importez la liste dans le bloc Pilotes de la compétition.")}</p> : null}
          <StandingsTable c={c} s={s} rid={current?.row.id} registry={pilots} />
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
              "Fichiers IGC ou archive .zip. Le pilote est reconnu au numéro du fichier ou, à défaut, au nom inscrit dans la trace ; une trace sans pilote reconnu est ajoutée à part, sans en écraser une autre. Une seconde trace pour un même pilote est gardée à côté de la première : le calcul retient la plus favorable au pilote. Pour remplacer une trace, utilisez « Remplacer » sur sa ligne.",
            )}
          </span>
        </form>
        {tracks.length ? (
          <details class="mt" open={openTracks}>
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
            {details ? (
              <TaskDetails r={results} settings={settings} />
            ) : (
              <TaskResults r={results} tz={settings.timeZone} taskId={tk.id} speedSection={distances.speedSection} registry={registry} only={ranking?.members} rid={ranking?.id} />
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
      {results ? <Results r={results} tz={tz} settings={settings} taskId={tk.id} /> : null}
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

/** Une ligne d'explication : ce qui est calculé, comment, et la valeur obtenue. */
const Calc: FC<{ label: string; how?: Child; value: Child }> = ({ label, how, value }) => (
  <tr>
    <th>{label}</th>
    <td class="how">{how}</td>
    <td class="n val">{value}</td>
  </tr>
);

/** Onglet « Détails de la manche » : validité, répartition des points et calcul d'un pilote, expliqués avec les valeurs de la manche. */
const TaskDetails: FC<{ r: TaskScoring; settings: CompetitionSettings }> = ({ r, settings }) => {
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

/** Classement de la manche, présenté comme les résultats publiés : rang, pilote, voile, temps, points. */
const TaskResults: FC<{
  r: TaskScoring;
  tz: string;
  taskId: number;
  speedSection: number;
  registry: PilotRow[];
  only?: Set<string>;
  rid?: number;
}> = ({ r, tz, taskId, speedSection, registry, only, rid }) => {
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
              <th class="n sp">{t("Pts distance")}</th>
              <th class="n sp">{t("Pts leading")}</th>
              <th class="n sp">{t("Pts temps")}</th>
              {elevated ? <th class="n sp">{t("Alt. goal")}</th> : null}
              {elevated ? <th class="n sp">{t("Réduc. pts temps")}</th> : null}
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
                    {p.fixes ? <a href={`/tasks/${taskId}/pilots/${encodeURIComponent(p.id)}`}>{p.name}</a> : p.name}
                    <StatusTags p={p} />
                  </td>
                  <id.Cells k={p.id} />
                  <td class="sp">{absent ? "" : localTime(p.startTime, tz)}</td>
                  <td class="sp">{timed ? localTime(p.essTime, tz) : ""}</td>
                  <td class="n sp">{timed ? duration(p.speedSectionTime) : ""}</td>
                  <td class="n sp">{timed ? fr((speedSection / p.speedSectionTime!) * 3.6, 1) : ""}</td>
                  <td class="n sp">{absent ? <span class="chip">{p.status}</span> : p.error ? <span class="chip s-ERREUR">{t("Erreur")}</span> : km(p.distance)}</td>
                  <td class="n sp">{pts(p.points?.distance)}</td>
                  <td class="n sp">{pts(p.points?.leading)}</td>
                  <td class="n sp">{pts(p.points?.time)}</td>
                  {elevated ? <td class="n sp">{p.goalAltitude != null && p.status === "GOAL" ? `${Math.round(p.goalAltitude)} m` : ""}</td> : null}
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
                  <th class="n">{t("Pts distance")}</th>
                  <th class="n">{t("Pts temps")}</th>
                  <th class="n">{t("Pts leading")}</th>
                {elevated ? <th class="n">{t("Alt. goal")}</th> : null}
                {elevated ? <th class="n">{t("Réduc. pts temps")}</th> : null}
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
                  {elevated ? (
                    <td class="n" title={p.goalAltitudeFactor !== undefined && p.goalAltitudeFactor < 1 ? t("Points de temps × {f} (elevated goal passé trop bas)", { f: p.goalAltitudeFactor.toFixed(3) }) : undefined}>
                      {p.goalAltitude != null ? `${Math.round(p.goalAltitude)} m` : ""}
                    </td>
                  ) : null}
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

export function resultsCsv(r: TaskScoring, tz: string): string {
  const head = [
    "rang", "pilote", "nom", "statut", "depart", "ess", "temps_s", "distance_km", "alt_arret_m", "lc", "leading",
    "pts_distance", "pts_temps", "pts_leading", "penalite_pts", "total", "espace_aerien", "profondeur_m", "penalite", "decisions", "alerte_leading",
    "alt_goal_m", "facteur_alt_goal", "reduction_pts_temps",
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
    p.goalAltitude != null ? Math.round(p.goalAltitude) : "",
    p.goalAltitudeFactor !== undefined ? p.goalAltitudeFactor.toFixed(4) : "",
    p.goalAltitudeLoss ? p.goalAltitudeLoss.toFixed(1) : "",
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

export const NotFound: FC<{ user?: User | null }> = ({ user }) => (
  <Layout title={t("Introuvable")} user={user ?? null}>
    <h1>{t("Page introuvable")}</h1>
    <p>
      <a href="/">{t("Retour à mes compétitions")}</a>
    </p>
  </Layout>
);


/** Mon compte : clés d'API pour les programmes (import et export de compétitions). */
export const AccountPage: FC<{ user: User; tokens: ApiTokenRow[]; baseUrl: string; token: string | null; error: string | null }> = ({ user, tokens, baseUrl, token, error }) => (
  <Layout title={t("Mon compte")} user={user}>
    <div class="crumbs">
      <a href="/">{t("Compétitions")}</a>
    </div>
    <h1>{t("Mon compte")}</h1>
    <p class="muted">{user.email}</p>
    <ErrorBox message={error} />
    <div class="card">
      <h2><Ic n="key" c="purple" />{t("Clés d'API")}</h2>
      <p class="small muted">
        {t("Une clé permet à un programme d'agir en votre nom : importer des compétitions et modifier les vôtres. Gardez-la secrète ; supprimez-la si elle a pu fuiter.")}{" "}
        <a href="/api">{t("Documentation de l'API")}</a>
      </p>
      {token ? (
        <div class="note">
          <p>{t("Nouvelle clé, affichée une seule fois : copiez-la maintenant.")}</p>
          <pre class="code">{token}</pre>
          <pre class="code">{`curl -H "Authorization: Bearer ${token}" ${baseUrl}/api/competitions`}</pre>
        </div>
      ) : null}
      {tokens.length ? (
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
            {tokens.map((k) => (
              <tr>
                <td>{k.name}</td>
                <td>{new Date(k.created_at).toLocaleString(locale())}</td>
                <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString(locale()) : t("jamais")}</td>
                <td class="n">
                  <form method="post" action={`/account/tokens/${k.id}/delete`}>
                    <button class="link">
                      <Bi n="trash" /> {t("Supprimer")}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form method="post" action="/account/tokens" class="row mt">
        <input type="text" name="name" placeholder={t("Nom de la clé (ex. script d'export)")} style="max-width:320px" required />
        <button class="primary">
          <Bi n="plus" />
          {t("Créer une clé")}
        </button>
      </form>
    </div>
  </Layout>
);

/** Documentation de l'API, avec des exemples prêts à copier. */
export const ApiDocPage: FC<{ user: User | null; baseUrl: string }> = ({ user, baseUrl }) => {
  const K = "pgs_xxxxxxxx";
  return (
    <Layout title={t("API")} user={user}>
      <div class="crumbs">
        <a href="/">{t("Compétitions")}</a>
      </div>
      <h1>{t("API")}</h1>
      <div class="card doc">
        <p>
          {t("Les lectures sont libres. Les écritures demandent une clé d'API, créée dans")} <a href="/account">{t("Mon compte")}</a>{" "}
          {t("et envoyée dans l'en-tête Authorization.")}
        </p>
        <pre class="code">{`Authorization: Bearer ${K}`}</pre>

        <h2>{t("Lister les compétitions")}</h2>
        <pre class="code">{`curl ${baseUrl}/api/competitions`}</pre>
        <p class="small muted">{t("Pour chaque compétition : id, nom, lieu, dates, adresse, date du dernier calcul, et si la clé peut la modifier.")}</p>

        <h2>{t("Exporter une compétition")}</h2>
        <pre class="code">{`curl -o gemona.pgscore.zip ${baseUrl}/api/competitions/12/export\ncurl -o gemona.pgscore.zip "${baseUrl}/api/competitions/12/export?tracks=0"   # ${t("sans les traces")}`}</pre>
        <p class="small muted">
          {t("Archive ZIP : competition.json (réglages, espace aérien, pilotes, classements, manches, décisions, liste des traces et derniers résultats) et les fichiers IGC tels que reçus, sous tracks/m<numéro>/<empreinte SHA-256>.igc.")}
        </p>

        <h2>{t("Importer une compétition")}</h2>
        <pre class="code">{`curl -H "Authorization: Bearer ${K}" --data-binary @gemona.pgscore.zip \\\n     -H "Content-Type: application/zip" ${baseUrl}/api/competitions/import`}</pre>
        <p class="small muted">
          {t("Crée une nouvelle compétition qui vous appartient, résultats compris (sans relancer de calcul). Réponse : id, adresse, nombre de manches, pilotes et traces. L'empreinte de chaque fichier IGC est vérifiée.")}
        </p>

        <h2>{t("Échanger avec FS (format FSDB)")}</h2>
        <pre class="code">{`curl -o gemona.fsdb ${baseUrl}/api/competitions/12/fsdb\ncurl -o gemona.fsdb.zip ${baseUrl}/api/competitions/12/fsdb.zip   # ${t("avec les traces")}\ncurl -H "Authorization: Bearer ${K}" --data-binary @comp.fsdb \\\n     -H "Content-Type: application/xml" ${baseUrl}/api/competitions/import`}</pre>
        <p class="small muted">
          {t("Le même point d'import reconnaît le FSDB (fichier .fsdb seul, ou ZIP contenant le .fsdb et ses dossiers de traces). Sont reprises : la compétition, la formule, les pilotes, les catégories (en classements), les manches et les pénalités saisies. Les résultats calculés par FS ne sont pas repris : le calcul est relancé dans pgscore.")}
        </p>

        <h2>{t("Autres actions")}</h2>
        <p class="small muted">
          {t("Avec la clé, un programme peut aussi utiliser les formulaires du site (envoi de traces, calcul, officialisation…) sur les compétitions qu'il a le droit de modifier.")}
        </p>
      </div>
    </Layout>
  );
};

export const AboutPage: FC<{ user: User | null }> = ({ user }) => (
  <Layout title={t("À propos")} user={user}>
    <div class="about">
      <h1 class="about-title">
        <img src="/logo.svg" alt="" width="48" height="48" />
        {t("À propos de pgscore")}
      </h1>
      <p class="lead">
        {t("pgscore est un logiciel de contrôle des traces et de scoring des compétitions de parapente cross-country. Il applique la formule GAP du Sporting Code FAI Section 7F (édition 2026), dans un navigateur, sans rien installer.")}
      </p>

      <div class="pill2">
        <div class="card">
          <h2><Ic n="zap" c="blue" />{t("Un outil moderne")}</h2>
          <p>
            {t("Les outils de référence ont fait leurs preuves, mais ils datent : FS est un logiciel Windows à installer sur le poste du scoreur, AirScore est né en 2007 en Perl et PHP. pgscore repart de zéro avec les technologies et les règles d'aujourd'hui.")}
          </p>
          <ul>
            <li>{t("Une application web : le scoreur, les pilotes et le public voient les mêmes résultats, en direct, sur ordinateur comme sur téléphone.")}</li>
            <li>{t("Les règles 2026 : formule GAP 2026 de la CIVL ou de la PWCA, manches arrêtées, FTV, espaces aériens, pénalités et décisions tracées.")}</li>
            <li>{t("Des calculs vérifiés : sur 7 manches de la PWCA (SVL) et la manche 1 du French Open 2026 (FS), environ 570 pilotes, les points tombent au dixième près.")}</li>
            <li>{t("Les formats du terrain : QR code et fichier XCTrack, traces IGC, espaces aériens OpenAir, import et export FSDB pour FS.")}</li>
            <li>{t("Des sorties prêtes à publier : classements extraits (féminin, nations, sport…), CSV, impression A4, visualisation 3D des vols.")}</li>
            <li>{t("Une API pour brancher d'autres outils : export et import de compétitions entières.")}</li>
          </ul>
        </div>
        <div class="card">
          <h2><Ic n="unlock" c="green" />{t("Libre et indépendant")}</h2>
          <p>
            {t("pgscore est un logiciel libre et open source : son code est public, chacun peut le lire, vérifier comment les points sont calculés, le corriger et l'améliorer.")}{" "}
            {t("Il est publié sous licence GNU AGPL-3.0 : toute version modifiée mise en ligne doit, elle aussi, publier son code.")}
          </p>
          <ul>
            <li>{t("Transparent : un résultat se vérifie en lisant le code, pas en faisant confiance à une boîte noire.")}</li>
            <li>{t("Indépendant : aucun éditeur commercial, aucune licence à payer, aucune dépendance à un service fermé.")}</li>
            <li>{t("Ouvert : vos données vous appartiennent. Une compétition s'exporte en entier, traces comprises, dans un format documenté.")}</li>
            <li>{t("Partagé : un club, une ligue ou une fédération peut l'installer sur son propre serveur.")}</li>
          </ul>
        </div>
      </div>

      <div class="card">
        <h2><Ic n="heart" c="pink" />{t("Sur les épaules des pionniers")}</h2>
        <p>
          {t("pgscore doit beaucoup à ceux qui l'ont précédé. CompCheck™ d'Ulric Jessop et SVL de Daniel Dimov sont des références : l'évolution et l'histoire du parapente de compétition ont été portées par leurs outils, à une époque où créer un logiciel demandait bien plus d'efforts qu'aujourd'hui. Merci à eux.")}
        </p>
        <p>
          {t("Merci aussi à Joerg Ewald : en plus de maintenir FS, il a travaillé sans relâche à décrire les standards de scoring. C'est ce travail qui rend possibles aujourd'hui les comparaisons entre logiciels et les initiatives open source comme pgscore.")}
        </p>
        <p>
          {t("Un bon logiciel de scoring ouvert à toute la communauté, c'est aussi la possibilité de faire évoluer la compétition elle-même : tester de nouvelles règles et de nouveaux formats compétitifs bien plus facilement, les appliquer à des manches réelles et comparer les classements obtenus.")}
        </p>
      </div>

      <div class="card">
        <h2><Ic n="users" c="amber" />{t("Qui porte le projet")}</h2>
        <p>
          {t("pgscore est porté par le travail de la FFVL (Fédération française de vol libre) et de Julien Garcia. Il est développé pour les compétitions de parapente de tous niveaux, de la compétition de club à la Coupe du monde.")}
        </p>
        <p class="small muted">
          {t("Code source, questions et contributions :")} <a href="https://github.com/julien66/pgscore">github.com/julien66/pgscore</a>
        </p>
      </div>
    </div>
  </Layout>
);

export type { Child };
