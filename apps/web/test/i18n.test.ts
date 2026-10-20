import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DICTS, format, pickLang, translate } from "../src/i18n.js";

const SRC = new URL("../src/", import.meta.url).pathname;

/** Textes à traduire : premiers arguments littéraux de t("…") (serveur) et T("…") (scripts de page). */
function keys(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "i18n") walk(f);
      } else if (/\.(tsx?|js)$/.test(e.name) && e.name !== "i18n.ts") {
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(/(?<![\w.])(?:t|T|N_)\(\s*"((?:[^"\\]|\\.)*)"/g)) out.add(JSON.parse(`"${m[1]}"`));
      }
    }
  };
  walk(SRC);
  return out;
}

describe("traductions", () => {
  const all = keys();

  it("relève les textes de l'interface", () => {
    expect(all.size).toBeGreaterThan(100);
  });

  for (const [lang, dict] of Object.entries(DICTS)) {
    it(`${lang} : chaque texte a sa traduction, avec les mêmes paramètres`, () => {
      const missing = [...all].filter((k) => !(k in dict));
      expect(missing, `${missing.length} textes sans traduction`).toEqual([]);
      for (const k of all) {
        const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(params(dict[k]!), `${lang} : « ${k} »`).toEqual(params(k));
      }
    });
  }

  it("choisit la langue : cookie, puis navigateur, puis français", () => {
    expect(pickLang("de", "en-GB,en")).toBe("de");
    expect(pickLang(undefined, "es-ES,es;q=0.9,en;q=0.8")).toBe("es");
    expect(pickLang("xx", "it-IT,ja")).toBe("fr");
    expect(format("{n} pilotes", { n: 3 })).toBe("3 pilotes");
    expect(translate("fr", "Manches")).toBe("Manches");
  });
});
