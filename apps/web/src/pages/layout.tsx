import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";
import type { User } from "../db.js";
import { lang, LANGS, locale, t } from "../i18n.js";

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
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.mt{margin-top:12px}.mb{margin-bottom:12px}
.params{display:flex;flex-direction:column;gap:14px}.param{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:4px 20px;align-items:center}.param label{margin:0;color:var(--text);font-size:14px;font-weight:600}.param p{margin:2px 0 0}.param .formula{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);opacity:.85}
@media (max-width:640px){.param{grid-template-columns:1fr}}
.muted{color:var(--muted)}.badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:8px;font-size:12px;background:var(--accent);color:var(--accent-ink)}details.replace{display:inline-block;margin-right:8px}details.replace summary{cursor:pointer;color:var(--accent);font-size:14px}details.replace form{display:flex;flex-direction:column;gap:6px;margin-top:6px;min-width:260px}.small{font-size:13px}.badge.warn{background:var(--warn);color:#fff}tr.from-tracks td{background:var(--chip)}
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
.list.comps li{flex-wrap:wrap;row-gap:2px}.list .comp-stats{flex-basis:100%}.list.runs li{display:block}.list.runs .bar{margin-top:6px}
.lead-warn{color:var(--warn);cursor:help;margin-right:4px}
table.pilots td{padding:3px 4px}table.pilots input[type=text],table.pilots select{padding:4px 6px;font-size:13px}
table.pilots .in-s{width:72px}table.pilots .in-m{width:120px}table.pilots .in-l{width:190px}table.pilots tr.new td{background:var(--chip)}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 12px;border-bottom:1px solid var(--line)}.tabs a{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;color:var(--muted)}.tabs a.on{background:var(--card);border-color:var(--line);color:var(--text);font-weight:600;margin-bottom:-1px}
[data-swap].loading{opacity:.55;transition:opacity .15s}
.tabs a.tab-end,.tabs form.tab-end{margin-left:auto}
.tabs form.tab-end{align-self:center}
.mtabs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin:-4px 0 10px}.mtabs a{padding:2px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:13px}.mtabs a.on{background:var(--chip);color:var(--text);font-weight:600}.mtabs .sep{width:8px}.mtabs a.mlink{border:0;font-size:12px}
.tabs .task-tabs{display:flex;gap:2px;margin-left:auto;align-self:flex-end}.tabs .task-tabs a{padding:6px 10px}
table.rk.sport-hidden .sp{display:none}.sp-toggle .sp-open{display:none}html.sport-open .sp-toggle .sp-open{display:inline}html.sport-open .sp-toggle .sp-closed{display:none}.rk-bar{display:flex;justify-content:flex-end;align-items:center;gap:8px 16px;flex-wrap:wrap;margin:4px 0}.rk-bar .acts{margin-right:auto}
@page{size:A4 portrait;margin:8mm}
.print-head{display:none}
body.printing{background:#fff;color:#000;font-size:10px}body.printing header,body.printing .no-print,body.printing .print-me nav.tabs,body.printing .print-me nav.mtabs,body.printing .print-me h2,body.printing .print-me .note,body.printing .print-me .print-rk,body.printing .print-me .rk-bar{display:none!important}
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
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
  stop: '<circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  settings: '<path d="M14 17H5"/><path d="M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
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
      <script src="/static/common.js" defer />
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
        <a href="/about">{t("À propos de pgscore")}</a> · <a href="/differences">{t("Différences CIVL / PWCA")}</a> · <a href="/api">{t("API")}</a> ·{" "}
        <a href="https://github.com/julien66/pgscore">{t("Logiciel libre, licence AGPL-3.0")}</a>
      </footer>
    </body>
  </html>
  </>
);

/** Logo « G » de Google, en couleurs (consignes de marque Google Sign-In). */
export const GoogleG: FC = () => (
  <svg class="gg" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

export const ErrorBox: FC<{ message?: string | null }> = ({ message }) => (message ? <div class="err">{message}</div> : null);

export function dateRange(a: string | null, b: string | null): string {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" });
  if (a && b && a !== b) return t("du {a} au {b}", { a: f(a), b: f(b) });
  return a ? f(a) : b ? f(b) : "";
}

export const NotFound: FC<{ user?: User | null }> = ({ user }) => (
  <Layout title={t("Introuvable")} user={user ?? null}>
    <h1>{t("Page introuvable")}</h1>
    <p>
      <a href="/">{t("Retour à mes compétitions")}</a>
    </p>
  </Layout>
);
