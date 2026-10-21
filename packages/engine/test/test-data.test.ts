import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Les tests de calcul PWCA sont sautés quand leurs traces manquent (poste de développement). En
 * intégration continue, ils doivent tourner : ce test échoue si les traces n'ont pas été téléchargées
 * (scripts/fetch-test-tracks.sh). La CI les saute exprès (REFERENCE_TESTS=skip) quand le changement ne
 * touche pas au calcul.
 */
describe.runIf(process.env.CI && process.env.REFERENCE_TESTS !== "skip")("traces de référence en intégration continue", () => {
  for (const name of ["GEMONA_T3_IGC_DIR", "FELTRE_T3_IGC_DIR", "PWCA_T1_IGC_DIR", "SOPOT_T1_IGC_DIR", "SOPOT_T2_IGC_DIR", "SOPOT_T3_IGC_DIR", "SOPOT_T4_IGC_DIR", "TDC_2026_ZIP"]) {
    it(`${name} pointe vers les traces`, () => {
      const dir = process.env[name];
      expect(dir, `${name} non défini`).toBeTruthy();
      expect(existsSync(dir!), `${dir} introuvable`).toBe(true);
    });
  }
});
