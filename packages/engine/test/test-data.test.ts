import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Les tests de calcul PWCA sont sautés quand leurs traces manquent (poste de développement). En
 * intégration continue, ils doivent tourner : ce test échoue si les traces n'ont pas été téléchargées
 * (scripts/fetch-test-tracks.sh).
 */
describe.runIf(process.env.CI)("traces de référence en intégration continue", () => {
  for (const name of ["GEMONA_T3_IGC_DIR", "FELTRE_T3_IGC_DIR", "PWCA_T1_IGC_DIR"]) {
    it(`${name} pointe vers les traces`, () => {
      const dir = process.env[name];
      expect(dir, `${name} non défini`).toBeTruthy();
      expect(existsSync(dir!), `${dir} introuvable`).toBe(true);
    });
  }
});
