/**
 * Paramètres de compétition (S7F 2026, chapitre 5), fixés par le directeur d'épreuve avant la
 * première manche. Distances en mètres, durées en secondes.
 *
 * Le S7F ne donne pas de valeurs par défaut (sauf FTV = 0 % en catégorie 1) : celles d'ici
 * sont les valeurs habituelles des logiciels de scoring, à ajuster par l'organisateur.
 * Depuis 2026, Nominal Launch (96 %) et Nominal Goal (30 %) sont fixes et ne sont plus ici.
 */
export interface CompetitionParameters {
  /** Distance nominale (5.1). */
  nominalDistance: number;
  /** Distance minimale (5.2) : distance accordée à tout pilote qui a décollé. */
  minimumDistance: number;
  /** Temps nominal de la section de vitesse (5.3). */
  nominalTime: number;
  /** Facteur FTV pour les manches retirées (5.4), entre 0 et 1. */
  ftvFactor: number;
}

export const DEFAULT_COMPETITION_PARAMETERS: Readonly<CompetitionParameters> = Object.freeze({
  nominalDistance: 70_000,
  minimumDistance: 5_000,
  nominalTime: 90 * 60,
  ftvFactor: 0,
});

/** Paramètres complets à partir de ceux que l'organisateur a fixés. */
export function competitionParameters(overrides: Partial<CompetitionParameters> = {}): CompetitionParameters {
  const p = { ...DEFAULT_COMPETITION_PARAMETERS, ...overrides };
  if (!(p.minimumDistance >= 0)) throw new Error("La distance minimale doit être positive ou nulle.");
  if (!(p.nominalDistance > p.minimumDistance)) throw new Error("La distance nominale doit dépasser la distance minimale.");
  if (!(p.nominalTime > 0)) throw new Error("Le temps nominal doit être positif.");
  if (!(p.ftvFactor >= 0 && p.ftvFactor <= 1)) throw new Error("Le facteur FTV doit être entre 0 et 1.");
  return p;
}

export interface ScoredDistance {
  /** Distance retenue pour le score, en mètres. */
  distance: number;
  /** Vrai si le pilote est ramené à la distance minimale (« MIND »). */
  minimumDistance: boolean;
}

/**
 * Distance retenue pour le score (9.3) : au moins la distance minimale pour tout pilote qui a décollé.
 * `flownDistance` vaut null pour un pilote sans trace valide dont le décollage a été constaté par
 * les officiels : il reçoit la distance minimale. Un pilote au goal a la distance de la manche.
 */
export function scoredDistance(flownDistance: number | null, params: Pick<CompetitionParameters, "minimumDistance">): ScoredDistance {
  const d = flownDistance ?? 0;
  if (d < params.minimumDistance) return { distance: params.minimumDistance, minimumDistance: true };
  return { distance: d, minimumDistance: false };
}
