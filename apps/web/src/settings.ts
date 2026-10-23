import {
  competitionParameters,
  DEFAULT_COMPETITION_PARAMETERS,
  type AirspacePenaltyRule,
  type CompetitionParameters,
  type GapProfile,
  type LeadingEnd,
  type LeadingFormula,
  type Task,
} from "@pgscore/engine";
import { N_, t } from "./i18n.js";

/** Réglages d'une compétition : paramètres GAP (S7F 5) et choix de règlement. */
export interface CompetitionSettings extends CompetitionParameters {
  /** Formule de points : GAP 2026 de la CIVL (comme FS) ou variante PWCA (comme SVL). */
  gapProfile: GapProfile;
  airspacePenaltyRule: AirspacePenaltyRule;
  /** Fuseau horaire du site, pour afficher et saisir les heures locales. */
  timeZone: string;
}

export const DEFAULT_SETTINGS: CompetitionSettings = {
  ...DEFAULT_COMPETITION_PARAMETERS,
  gapProfile: "S7F2026",
  airspacePenaltyRule: "s7a",
  timeZone: "Europe/Paris",
};

export const GAP_PROFILES: Record<GapProfile, string> = {
  S7F2026: N_("CIVL GAP 2026 (comme FS)"),
  PWCA: N_("PWCA 2026 (comme SVL)"),
};

export const PENALTY_RULES: Record<AirspacePenaltyRule, string> = {
  s7a: N_("S7A 2026 : 0 à 100 % des points entre 0 et 100 m"),
  "pwca-soft": N_("PWCA « soft » : 1000 points à 100 m"),
  "pwca-hard": N_("PWCA « hard » : 1000 points à 50 m"),
};

/** Fin des vols pour maxTime du leading, réglée par manche. */
export const LEADING_ENDS: Record<LeadingEnd, string> = {
  lastEss: N_("Dernière arrivée à l'ESS"),
  lastLanding: N_("Dernier pilote en vol (posé plus tardif)"),
};

/** Formule du leading pour la partie de vol manquante des pilotes posés, réglée par manche. */
export const LEADING_FORMULAS: Record<LeadingFormula, string> = {
  GAP2026: N_("GAP2026 : intégrale du poids (S7F 2026, FS récent, SVL)"),
  GAP2025: N_("GAP2025 : distance restante × poids (FS GAP2025)"),
};

/** Orientation d'un goal en ligne, réglée par manche (rubrique « Règles anciennes »). */
export const GOAL_LINE_ORIENTATIONS: Record<NonNullable<Task["goalLineOrientation"]>, string> = {
  route: N_("Perpendiculaire à la route optimisée (S7F 2026, PWCA)"),
  previousCentre: N_("Perpendiculaire au centre de la balise précédente (S7F 2024)"),
};

/**
 * Limites d'espace aérien converties depuis les pieds arrondies au mètre : avec la formule PWCA,
 * comme SVL (logiciel de la PWCA) ; sans arrondi avec la formule CIVL, comme FS.
 */
export const roundsAirspaceLimits = (s: Pick<CompetitionSettings, "gapProfile">): boolean => s.gapProfile === "PWCA";

export function parseSettings(json: string): CompetitionSettings {
  // leadingProfile : ancien choix du calcul de leading, retiré (un seul calcul, celui de FS et SVL).
  // roundAirspaceLimits : ancienne case à cocher, l'arrondi suit maintenant la formule.
  const { leadingProfile: _old, roundAirspaceLimits: _round, ...stored } = JSON.parse(json) as Partial<CompetitionSettings> & {
    leadingProfile?: unknown;
    roundAirspaceLimits?: unknown;
  };
  return { ...DEFAULT_SETTINGS, ...stored };
}

export class FormError extends Error {}

function num(form: Record<string, unknown>, key: string, label: string): number {
  const v = Number(String(form[key] ?? "").replace(",", "."));
  if (!Number.isFinite(v)) throw new FormError(t("{label} : nombre attendu.", { label }));
  return v;
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Barème de pénalité d'espace aérien lu depuis le formulaire ; à défaut, celui d'avant. */
export function penaltyRuleFromForm(form: Record<string, unknown>, previous: AirspacePenaltyRule = DEFAULT_SETTINGS.airspacePenaltyRule): AirspacePenaltyRule {
  if (form.airspacePenaltyRule === undefined || form.airspacePenaltyRule === "") return previous;
  const rule = String(form.airspacePenaltyRule) as AirspacePenaltyRule;
  if (!(rule in PENALTY_RULES)) throw new FormError(t("Barème d'espace aérien inconnu."));
  return rule;
}

/**
 * Réglages lus depuis le formulaire (distances en km, temps en minutes, FTV en %). La pénalité
 * d'espace aérien se règle dans sa propre rubrique : absente du formulaire, on garde celle d'avant.
 */
export function settingsFromForm(form: Record<string, unknown>, previous: CompetitionSettings = DEFAULT_SETTINGS): CompetitionSettings {
  const gapProfile = String(form.gapProfile ?? DEFAULT_SETTINGS.gapProfile) as GapProfile;
  if (!(gapProfile in GAP_PROFILES)) throw new FormError(t("Formule de points inconnue."));
  const airspacePenaltyRule = penaltyRuleFromForm(form, previous.airspacePenaltyRule);
  const timeZone = String(form.timeZone ?? "").trim() || DEFAULT_SETTINGS.timeZone;
  if (!isTimeZone(timeZone)) throw new FormError(t("Fuseau horaire inconnu : {timeZone}", { timeZone }));
  let params;
  try {
    params = competitionParameters({
      nominalDistance: num(form, "nominalDistance", t("Distance nominale")) * 1000,
      minimumDistance: num(form, "minimumDistance", t("Distance minimale")) * 1000,
      nominalTime: num(form, "nominalTime", t("Temps nominal")) * 60,
      ftvFactor: num(form, "ftvFactor", t("Facteur FTV")) / 100,
    });
  } catch (e) {
    throw new FormError((e as Error).message);
  }
  return {
    ...params,
    gapProfile,
    airspacePenaltyRule,
    timeZone,
  };
}

/** Réglages de points propres à une manche, rangés avec elle. */
export interface TaskScoringSettings {
  /** Leading Time Ratio (11), entre 0 et 0,26 ; à défaut, celui de la formule. */
  leadingTimeRatio?: number;
  /** Pilotes présents au décollage (tous sauf ABS) ; à défaut, ceux qui ont une trace avec un vol. */
  pilotsPresent?: number;
  /** Fin de manche pour le leading (UTC, "HH:MM:SS") si elle est plus tardive que la fin des vols. */
  taskEndTime?: string;
  /** Fin des vols pour le leading : dernière arrivée à l'ESS (par défaut) ou dernier pilote en vol. */
  leadingEnd?: LeadingEnd;
  /** Formule du leading pour les pilotes posés : GAP2026 (par défaut) ou GAP2025 (FS). */
  leadingFormula?: LeadingFormula;
}

export type StoredTask = Task & TaskScoringSettings;

/** Réglages de manche lus depuis le formulaire (LTR en %, heure de fin déjà convertie en UTC). */
export function taskScoringFromForm(form: Record<string, unknown>): TaskScoringSettings {
  const out: TaskScoringSettings = {};
  const ltr = String(form.leadingTimeRatio ?? "").trim().replace(",", ".");
  if (ltr) {
    const v = Number(ltr);
    if (!(v >= 0 && v <= 26.5)) throw new FormError(t("Leading Time Ratio : entre 0 et 26 %."));
    out.leadingTimeRatio = v / 100;
  }
  const present = String(form.pilotsPresent ?? "").trim();
  if (present) {
    const v = Number(present);
    if (!(Number.isInteger(v) && v >= 0)) throw new FormError(t("Pilotes présents : nombre entier attendu."));
    out.pilotsPresent = v;
  }
  const end = String(form.leadingEnd ?? "lastEss");
  if (!(end in LEADING_ENDS)) throw new FormError(t("Fin des vols pour le leading inconnue."));
  if (end !== "lastEss") out.leadingEnd = end as LeadingEnd;
  const formula = String(form.leadingFormula ?? "GAP2026");
  if (!(formula in LEADING_FORMULAS)) throw new FormError(t("Formule du leading inconnue."));
  if (formula !== "GAP2026") out.leadingFormula = formula as LeadingFormula;
  return out;
}

/** Tolérance relative des cylindres de la PWCA : 0,1 % (le S7F 2026 n'en garde aucune). */
export const PWCA_CYLINDER_TOLERANCE = 0.001;

/** Manche telle qu'on la contrôle : tolérance des cylindres de la formule si la manche n'en fixe pas. */
export function controlTask<T extends { cylinderTolerance?: number }>(task: T, s: Pick<CompetitionSettings, "gapProfile">): T {
  if (task.cylinderTolerance !== undefined || s.gapProfile !== "PWCA") return task;
  return { ...task, cylinderTolerance: PWCA_CYLINDER_TOLERANCE };
}
