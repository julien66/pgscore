import {
  competitionParameters,
  DEFAULT_COMPETITION_PARAMETERS,
  type AirspacePenaltyRule,
  type CompetitionParameters,
  type GapProfile,
  type LeadingProfile,
  type Task,
} from "@pgscore/engine";

/** Réglages d'une compétition : paramètres GAP (S7F 5) et choix de règlement. */
export interface CompetitionSettings extends CompetitionParameters {
  /** Formule de points : S7F 2026 ou variante PWCA (SVL). */
  gapProfile: GapProfile;
  leadingProfile: LeadingProfile;
  airspacePenaltyRule: AirspacePenaltyRule;
  /** Arrondi au mètre des limites converties depuis les pieds (comme SVL, logiciel de la PWCA). */
  roundAirspaceLimits: boolean;
  /** Fuseau horaire du site, pour afficher et saisir les heures locales. */
  timeZone: string;
}

export const DEFAULT_SETTINGS: CompetitionSettings = {
  ...DEFAULT_COMPETITION_PARAMETERS,
  gapProfile: "S7F2026",
  leadingProfile: "S7F2026",
  airspacePenaltyRule: "s7a",
  roundAirspaceLimits: false,
  timeZone: "Europe/Paris",
};

export const GAP_PROFILES: Record<GapProfile, string> = {
  S7F2026: "S7F 2026 (texte FAI)",
  PWCA: "PWCA 2026 (comme SVL)",
};

export const LEADING_PROFILES: Record<LeadingProfile, string> = {
  S7F2026: "S7F 2026 (texte FAI)",
  PWCA: "PWCA (comme SVL)",
};

export const PENALTY_RULES: Record<AirspacePenaltyRule, string> = {
  s7a: "S7A 2026 : 0 à 100 % des points entre 0 et 100 m",
  "pwca-soft": "PWCA « soft » : 1000 points à 100 m",
  "pwca-hard": "PWCA « hard » : 1000 points à 50 m",
};

export function parseSettings(json: string): CompetitionSettings {
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(json) as Partial<CompetitionSettings>) };
}

export class FormError extends Error {}

function num(form: Record<string, unknown>, key: string, label: string): number {
  const v = Number(String(form[key] ?? "").replace(",", "."));
  if (!Number.isFinite(v)) throw new FormError(`${label} : nombre attendu.`);
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

/** Réglages lus depuis le formulaire (distances en km, temps en minutes, FTV en %). */
export function settingsFromForm(form: Record<string, unknown>): CompetitionSettings {
  const gapProfile = String(form.gapProfile ?? DEFAULT_SETTINGS.gapProfile) as GapProfile;
  if (!(gapProfile in GAP_PROFILES)) throw new FormError("Formule de points inconnue.");
  const leadingProfile = String(form.leadingProfile) as LeadingProfile;
  const airspacePenaltyRule = String(form.airspacePenaltyRule) as AirspacePenaltyRule;
  if (!(leadingProfile in LEADING_PROFILES)) throw new FormError("Profil de leading inconnu.");
  if (!(airspacePenaltyRule in PENALTY_RULES)) throw new FormError("Barème d'espace aérien inconnu.");
  const timeZone = String(form.timeZone ?? "").trim() || DEFAULT_SETTINGS.timeZone;
  if (!isTimeZone(timeZone)) throw new FormError(`Fuseau horaire inconnu : ${timeZone}`);
  let params;
  try {
    params = competitionParameters({
      nominalDistance: num(form, "nominalDistance", "Distance nominale") * 1000,
      minimumDistance: num(form, "minimumDistance", "Distance minimale") * 1000,
      nominalTime: num(form, "nominalTime", "Temps nominal") * 60,
      ftvFactor: num(form, "ftvFactor", "Facteur FTV") / 100,
    });
  } catch (e) {
    throw new FormError((e as Error).message);
  }
  return { ...params, gapProfile, leadingProfile, airspacePenaltyRule, roundAirspaceLimits: form.roundAirspaceLimits === "on", timeZone };
}

/** Réglages de points propres à une manche, rangés avec elle. */
export interface TaskScoringSettings {
  /** Leading Time Ratio (11), entre 0 et 0,26 ; à défaut, celui de la formule. */
  leadingTimeRatio?: number;
  /** Pilotes présents au décollage (tous sauf ABS) ; à défaut, ceux qui ont une trace avec un vol. */
  pilotsPresent?: number;
  /** Fin de manche pour le leading (UTC, "HH:MM:SS") si elle est plus tardive que le dernier posé. */
  taskEndTime?: string;
}

export type StoredTask = Task & TaskScoringSettings;

/** Réglages de manche lus depuis le formulaire (LTR en %, heure de fin déjà convertie en UTC). */
export function taskScoringFromForm(form: Record<string, unknown>): TaskScoringSettings {
  const out: TaskScoringSettings = {};
  const ltr = String(form.leadingTimeRatio ?? "").trim().replace(",", ".");
  if (ltr) {
    const v = Number(ltr);
    if (!(v >= 0 && v <= 26.5)) throw new FormError("Leading Time Ratio : entre 0 et 26 %.");
    out.leadingTimeRatio = v / 100;
  }
  const present = String(form.pilotsPresent ?? "").trim();
  if (present) {
    const v = Number(present);
    if (!(Number.isInteger(v) && v >= 0)) throw new FormError("Pilotes présents : nombre entier attendu.");
    out.pilotsPresent = v;
  }
  return out;
}
