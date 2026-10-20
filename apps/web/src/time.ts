import { locale, t } from "./i18n.js";

/** Heures : la manche est en UTC (comme XCTrack), l'affichage et la saisie en heure locale du site. */

export function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Heure locale "HH:MM:SS" d'un instant (ms UTC). */
export function localTime(utcMs: number | null | undefined, timeZone: string): string {
  if (utcMs === null || utcMs === undefined) return "";
  return new Intl.DateTimeFormat("fr-FR", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(
    new Date(utcMs),
  );
}

/** "HH:MM[:SS]" UTC de la manche → heure locale "HH:MM:SS" le jour donné ("AAAA-MM-JJ"). */
export function utcHmsToLocal(hms: string, date: string | null, timeZone: string): string {
  const [h, m, s] = hms.split(":").map(Number);
  const day = date ? Date.parse(`${date}T00:00:00Z`) : Date.UTC(2026, 0, 1);
  return localTime(day + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000, timeZone);
}

/** Heure locale saisie "HH:MM[:SS]" le jour donné → "HH:MM:SS" UTC. */
export function localHmsToUtc(hms: string, date: string | null, timeZone: string): string {
  const mt = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hms.trim());
  if (!mt) throw new Error(t("Heure invalide : « {value} » (attendu HH:MM ou HH:MM:SS).", { value: hms }));
  const day = date ? Date.parse(`${date}T00:00:00Z`) : Date.UTC(2026, 0, 1);
  const naive = day + (Number(mt[1]) * 3600 + Number(mt[2]) * 60 + Number(mt[3] ?? 0)) * 1000;
  // Deux passes pour tomber juste autour d'un changement d'heure.
  let utc = naive - offsetMinutes(naive, timeZone) * 60_000;
  utc = naive - offsetMinutes(utc, timeZone) * 60_000;
  return new Date(utc).toISOString().slice(11, 19);
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const km = (m: number | null | undefined, digits = 2) =>
  m === null || m === undefined ? "" : (m / 1000).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
