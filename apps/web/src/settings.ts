import {
  competitionParameters,
  DEFAULT_COMPETITION_PARAMETERS,
  type AirspacePenaltyRule,
  type CompetitionParameters,
  type GapProfile,
  type Task,
} from "@pgscore/engine";
import { N_, t } from "./i18n.js";

/** Réglages d'une compétition : paramètres GAP (S7F 5) et choix de règlement. */
export interface CompetitionSettings extends CompetitionParameters {
  /** Formule de points : GAP 2026 de la CIVL (comme FS) ou variante PWCA (comme SVL). */
  gapProfile: GapProfile;
  airspacePenaltyRule: AirspacePenaltyRule;
  /** Arrondi au mètre des limites converties depuis les pieds (comme SVL, logiciel de la PWCA). */
  roundAirspaceLimits: boolean;
  /** Fuseau horaire du site, pour afficher et saisir les heures locales. */
  timeZone: string;
}

export const DEFAULT_SETTINGS: CompetitionSettings = {
  ...DEFAULT_COMPETITION_PARAMETERS,
  gapProfile: "S7F2026",
  airspacePenaltyRule: "s7a",
  roundAirspaceLimits: false,
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

export function parseSettings(json: string): CompetitionSettings {
  // leadingProfile : ancien choix du calcul de leading, retiré (un seul calcul, celui de FS et SVL).
  const { leadingProfile: _old, ...stored } = JSON.parse(json) as Partial<CompetitionSettings> & { leadingProfile?: unknown };
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

/** Réglages lus depuis le formulaire (distances en km, temps en minutes, FTV en %). */
export function settingsFromForm(form: Record<string, unknown>): CompetitionSettings {
  const gapProfile = String(form.gapProfile ?? DEFAULT_SETTINGS.gapProfile) as GapProfile;
  if (!(gapProfile in GAP_PROFILES)) throw new FormError(t("Formule de points inconnue."));
  const airspacePenaltyRule = String(form.airspacePenaltyRule) as AirspacePenaltyRule;
  if (!(airspacePenaltyRule in PENALTY_RULES)) throw new FormError(t("Barème d'espace aérien inconnu."));
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
  return { ...params, gapProfile, airspacePenaltyRule, roundAirspaceLimits: form.roundAirspaceLimits === "on", timeZone };
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
    if (!(v >= 0 && v <= 26.5)) throw new FormError(t("Leading Time Ratio : entre 0 et 26 %."));
    out.leadingTimeRatio = v / 100;
  }
  const present = String(form.pilotsPresent ?? "").trim();
  if (present) {
    const v = Number(present);
    if (!(Number.isInteger(v) && v >= 0)) throw new FormError(t("Pilotes présents : nombre entier attendu."));
    out.pilotsPresent = v;
  }
  return out;
}
