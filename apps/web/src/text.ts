/** Petits outils de texte partagés : CSV, entités XML/HTML et noms de fichiers encodés par FS. */

// --- CSV ------------------------------------------------------------------------------------

/** Cellule CSV : entre guillemets doubles seulement si elle contient un séparateur, un guillemet ou un saut de ligne. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Fichier CSV (virgules, une ligne par tableau, saut de ligne final). */
export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/** Lit un CSV (séparateur , ; ou tabulation, deviné sur la première ligne ; guillemets doubles). */
export function parseCsvRows(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const first = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", "\t", ","].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

// --- Entités ----------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Décode les entités nommées courantes et numériques (&#233; &#xE9;) ; les autres restent telles quelles. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

// --- Noms de fichiers ------------------------------------------------------------------------

/** Lettres accentuées écrites « #U00e9 » par FS et certains outils de ZIP, redécodées. */
export const decodeFsName = (s: string) => s.replace(/#U([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
