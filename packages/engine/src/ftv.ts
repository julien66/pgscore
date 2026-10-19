/**
 * Classement général de la compétition, avec le FTV (S7F 2026, chapitres 15 et 16).
 *
 * Validité d'une manche pour le FTV : points du vainqueur / 1000.
 * Validité totale fixe : (1 − facteur FTV) × somme des validités des manches.
 * Pour chaque pilote, les manches sont prises par performance décroissante (score / score du vainqueur)
 * et ses scores bruts s'additionnent jusqu'à atteindre la validité totale fixe ; la manche qui la dépasse
 * ne compte que pour la part restante. Le total est arrondi une seule fois, au dixième.
 */

export interface FtvTaskInput {
  key: string;
  /** Manche arrêtée : retirée du classement si sa validité est sous 0,05 (chapitre 15). */
  stopped?: boolean;
  results: Array<{ pilot: string; name?: string; total: number | null }>;
}

export interface FtvTask {
  key: string;
  /** Points du vainqueur. */
  winner: number;
  /** Validité pour le FTV : vainqueur / 1000. */
  validity: number;
  included: boolean;
  /** Raison de l'exclusion. */
  excluded?: string;
}

export interface FtvTaskScore {
  /** Score de la manche. */
  score: number;
  /** Performance : score / score du vainqueur. */
  performance: number;
  /** Part du score retenue (0 à 1) et points retenus. */
  fraction: number;
  counted: number;
}

export interface FtvPilot {
  pilot: string;
  name: string;
  rank: number;
  total: number;
  /** Total sans FTV (somme simple), arrondi au dixième. */
  sum: number;
  tasks: Record<string, FtvTaskScore>;
}

export interface CompetitionRanking {
  ftvFactor: number;
  tasks: FtvTask[];
  /** Validité totale fixe, et points correspondants (× 1000). */
  fixedTotalValidity: number;
  pilots: FtvPilot[];
}

const round1 = (v: number) => Math.round(v * 10 + Math.sign(v) * 1e-9) / 10;
export const MIN_STOPPED_VALIDITY = 0.05;

export function competitionRanking(input: FtvTaskInput[], ftvFactor: number): CompetitionRanking {
  if (!(ftvFactor >= 0 && ftvFactor <= 1)) throw new Error("Le facteur FTV doit être entre 0 et 1.");
  const tasks: FtvTask[] = input.map((t) => {
    const winner = Math.max(0, ...t.results.map((r) => r.total ?? 0));
    const validity = winner / 1000;
    const task: FtvTask = { key: t.key, winner, validity, included: true };
    if (winner <= 0) Object.assign(task, { included: false, excluded: "aucun point marqué" });
    else if (t.stopped && validity < MIN_STOPPED_VALIDITY)
      Object.assign(task, { included: false, excluded: "manche arrêtée de validité inférieure à 0,05" });
    return task;
  });
  const counted = tasks.filter((t) => t.included);
  const fixedTotalValidity = (1 - ftvFactor) * counted.reduce((s, t) => s + t.validity, 0);

  // Pilotes : réunis sur toutes les manches, nom le plus récent.
  const pilots = new Map<string, { name: string; scores: Map<string, number> }>();
  input.forEach((t) => {
    for (const r of t.results) {
      const p = pilots.get(r.pilot) ?? { name: r.name ?? "", scores: new Map() };
      if (r.name) p.name = r.name;
      p.scores.set(t.key, Math.max(0, r.total ?? 0));
      pilots.set(r.pilot, p);
    }
  });

  const out: FtvPilot[] = [];
  for (const [pilot, p] of pilots) {
    const scores: Record<string, FtvTaskScore> = {};
    const entries = counted.map((t) => {
      const score = p.scores.get(t.key) ?? 0;
      const s: FtvTaskScore = { score, performance: score / t.winner, fraction: 0, counted: 0 };
      scores[t.key] = s;
      return { t, s };
    });
    // Performance décroissante ; à égalité, la manche la plus valide d'abord (le S7F ne tranche pas).
    entries.sort((a, b) => b.s.performance - a.s.performance || b.t.validity - a.t.validity);
    let used = 0;
    let total = 0;
    for (const { t, s } of entries) {
      const left = Math.max(0, fixedTotalValidity - used);
      s.fraction = Math.min(1, left / t.validity);
      s.counted = s.score * s.fraction;
      total += s.counted;
      used += t.validity * s.fraction;
    }
    const sum = entries.reduce((a, e) => a + e.s.score, 0);
    out.push({ pilot, name: p.name, rank: 0, total: round1(total), sum: round1(sum), tasks: scores });
  }
  out.sort((a, b) => b.total - a.total || b.sum - a.sum || a.name.localeCompare(b.name));
  out.forEach((p, i) => {
    const prev = out[i - 1];
    p.rank = prev && prev.total === p.total ? prev.rank : i + 1;
  });
  return { ftvFactor, tasks, fixedTotalValidity, pilots: out };
}
