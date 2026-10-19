import {parseXctsk,parseIgc,controlFlight} from "../src/index.ts";import {readFileSync,readdirSync} from "fs";
const task=parseXctsk(readFileSync(new URL("../test/fixtures/pwca-baixo-guandu-2026-t1.qr.txt",import.meta.url),"utf8").trim());
const dir=(process.argv[2]??".").replace(/\/?$/,"/");
const ref=readFileSync(new URL("../test/fixtures/pwca-baixo-guandu-2026-t1-results.csv",import.meta.url),"utf8").trim().split("\n").slice(1).map(l=>l.split(","));
const loc=(ms:number|null)=>ms==null?"":new Date(ms-3*3600e3).toISOString().slice(11,19);
let ok=0;const t0=Date.now();
for(const [id,name,start,ess,dist,status] of ref){const f=readdirSync(dir).find(f=>f===`${id}.igc`||f.endsWith(`.${id}.igc`))!;
const c=controlFlight(task,parseIgc(readFileSync(dir+f,"latin1")).fixes);
const st=c.madeGoal?"GOAL":c.madeEss?"ESS":"DF";const d=(c.flownDistance/1000).toFixed(2);
const same=st===status&&loc(c.sssTime)===start&&loc(c.essTime)===ess&&Math.abs(Number(d)-Number(dist))<0.015;if(same)ok++;
console.log(same?"  ":"≠ ",id!.padEnd(6),st.padEnd(4),status!.padEnd(4),loc(c.sssTime),start,loc(c.essTime).padEnd(8),ess!.padEnd(8),d,dist);}
console.log("identiques",ok,"/",ref.length,(Date.now()-t0)/1000,"s");
