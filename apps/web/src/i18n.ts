import { AsyncLocalStorage } from "node:async_hooks";
import de from "./i18n/de.js";
import en from "./i18n/en.js";
import es from "./i18n/es.js";

/**
 * Traduction de l'interface. Le texte français sert de clé : t("Manches") en français renvoie
 * « Manches », en anglais la traduction de en.ts, à défaut le français. Les paramètres s'écrivent
 * {nom} : t("{n} pilotes", { n: 12 }). Le premier argument doit être une chaîne littérale entre
 * guillemets doubles (le test d'exhaustivité des traductions les relève dans le code).
 *
 * La langue de la requête en cours est gardée dans un AsyncLocalStorage : les composants n'ont pas
 * à la recevoir en paramètre.
 */

export const LANGS = { fr: "Français", en: "English", es: "Español", de: "Deutsch" } as const;
export type Lang = keyof typeof LANGS;
export const LANG_COOKIE = "lang";

export const DICTS: Record<Exclude<Lang, "fr">, Record<string, string>> = { en, es, de };
const LOCALES: Record<Lang, string> = { fr: "fr-FR", en: "en-GB", es: "es-ES", de: "de-DE" };

const store = new AsyncLocalStorage<Lang>();

export const isLang = (x: unknown): x is Lang => typeof x === "string" && x in LANGS;
export const withLang = <T>(lang: Lang, fn: () => T): T => store.run(lang, fn);
export const lang = (): Lang => store.getStore() ?? "fr";
/** Locale Intl de la langue en cours (nombres, dates). */
export const locale = (): string => LOCALES[lang()];

export function format(s: string, params?: Record<string, string | number>): string {
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

export function translate(l: Lang, fr: string, params?: Record<string, string | number>): string {
  return format(l === "fr" ? fr : (DICTS[l][fr] ?? fr), params);
}

/**
 * Marque un texte à traduire plus tard, sans le traduire : pour les libellés de constantes définies au
 * chargement du module (hors requête). À l'affichage : t(libellé).
 */
export const N_ = <S extends string>(fr: S): S => fr;

export function t(fr: string, params?: Record<string, string | number>): string {
  return translate(lang(), fr, params);
}

/** Langue choisie (cookie), sinon la première langue connue de l'en-tête Accept-Language, sinon français. */
export function pickLang(cookie: string | undefined, acceptLanguage: string | undefined): Lang {
  if (isLang(cookie)) return cookie;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return "fr";
}

/** Dictionnaire envoyé aux scripts de la page (window.T). */
export function clientScript(l: Lang): string {
  const dict = l === "fr" ? {} : DICTS[l];
  return `window.I18N_LANG=${JSON.stringify(l)};window.I18N_LOCALE=${JSON.stringify(LOCALES[l])};window.I18N=${JSON.stringify(dict).replace(/</g, "\\u003c")};
window.T=function(s,p){var x=window.I18N[s]||s;return p?x.replace(/\\{(\\w+)\\}/g,function(m,k){return k in p?String(p[k]):m}):x};`;
}
