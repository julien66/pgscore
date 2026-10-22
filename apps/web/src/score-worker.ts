import { parentPort, workerData } from "node:worker_threads";
import { controlPilot, finishScoringBest, parseOpenAir, type ControlledPilot, type ScoringOptions, type Task } from "@pgscore/engine";
import { TrackStore } from "./track-store.js";

/**
 * Calcul d'une manche hors du fil principal (lancé par runner.ts) : contrôle des traces puis leading et
 * classement. Le worker ne touche pas à la base : il lit les IGC dans le dossier des traces et envoie
 * son avancement au fil principal, qui l'enregistre.
 */

export interface ScoreJob {
  storeDir: string;
  task: Task;
  options: Omit<ScoringOptions, "airspaces">;
  airspaceText: string | null;
  /** Traces de la manche, avec le nom du pilote inscrit sous ce numéro s'il y en a un. */
  tracks: Array<{ pilot_key: string; pilot_name: string | null; sha256: string }>;
}

export type ScoreMessage =
  | { type: "airspaces"; count: number }
  | { type: "start"; index: number; pilot: string }
  | { type: "pilot"; index: number; name: string; status: string; error: string | null; distance: number; airspace: string | null }
  | { type: "leading" }
  | { type: "done"; result: unknown };

const job = workerData as ScoreJob;
const post = (m: ScoreMessage) => parentPort!.postMessage(m);
const store = new TrackStore(job.storeDir);
const options: ScoringOptions = { ...job.options, airspaces: job.airspaceText ? parseOpenAir(job.airspaceText) : [] };
post({ type: "airspaces", count: options.airspaces!.length });

// Traces contrôlées regroupées par pilote : un pilote peut en avoir plusieurs.
const groups = new Map<string, Array<{ cp: ControlledPilot; sha256: string }>>();
for (const [index, tr] of job.tracks.entries()) {
  post({ type: "start", index, pilot: tr.pilot_name ?? tr.pilot_key });
  const igc = store.text(tr.sha256);
  const cp = controlPilot(job.task, tr.pilot_name ? { id: tr.pilot_key, name: tr.pilot_name, igc } : { id: tr.pilot_key, igc }, options);
  const g = groups.get(tr.pilot_key) ?? [];
  g.push({ cp, sha256: tr.sha256 });
  groups.set(tr.pilot_key, g);
  const r = cp.result;
  post({ type: "pilot", index, name: r.name, status: r.status, error: r.error ?? null, distance: r.distance, airspace: r.airspace[0]?.name ?? null });
}

// Leading (dépend de tous les pilotes) et classement.
post({ type: "leading" });
const list = [...groups.values()];
const { scoring, chosen } = finishScoringBest(job.task, list.map((g) => g.map((x) => x.cp)), options);
// Trace retenue, pour les pilotes qui en ont plusieurs (affichage, visionneuse, export FS).
const chosenTracks: Record<string, string> = {};
list.forEach((g, i) => {
  if (g.length > 1) chosenTracks[g[0]!.cp.result.id] = g[chosen[i]!]!.sha256;
});
post({ type: "done", result: Object.keys(chosenTracks).length ? { ...scoring, chosenTracks } : scoring });
