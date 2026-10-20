import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pilotsFromCsv, pilotsFromFile, pilotsFromFsdb } from "../src/pilots.js";

describe("import des pilotes", () => {
  it("lit un FSDB du logiciel FS", () => {
    const list = pilotsFromFsdb(readFileSync(new URL("fixtures/sample.fsdb", import.meta.url), "utf8"));
    expect(list).toEqual([
      expect.objectContaining({ pilot_key: "2", name: "Baptiste Lambert", gender: "M", nation: "FRA", civl_id: "12345", glider_brand: "Ozone", glider_model: "Enzo 3" }),
      expect.objectContaining({
        pilot_key: "269",
        name: "Mélanie Pfister & co",
        gender: "F",
        nation: "SUI",
        glider_brand: "Gin",
        glider_model: "Leopard",
        glider_class: "EN-D",
        harness_brand: "Gin",
        harness_model: "Genie Race 5",
      }),
    ]);
  });

  it("lit un CSV au point-virgule avec des en-têtes en français", () => {
    const csv = "N°;Nom;Sexe;Pays;Voile;Classe;Sellette;PTV max\n12;Ana;F;fra;Ozone Zeno 2;en-d;Woody Valley X-Alps;98,5\n7;Bruno;H;ITA;;;;\n";
    const list = pilotsFromCsv(csv);
    expect(list[0]).toMatchObject({ pilot_key: "12", gender: "F", nation: "FRA", glider_brand: "Ozone", glider_model: "Zeno 2", glider_class: "EN-D", harness_brand: "Woody", harness_model: "Valley X-Alps", weight_max: 98.5 });
    expect(list[1]).toMatchObject({ pilot_key: "7", gender: "M", glider_brand: null, weight_max: null });
  });

  it("refuse un fichier sans numéro ou avec un numéro en double", () => {
    expect(() => pilotsFromCsv("nom\nAna\n")).toThrow(/numero/);
    expect(() => pilotsFromFile("p.csv", "numero,nom\n1,A\n1,B\n")).toThrow(/double/);
    expect(() => pilotsFromCsv("numero,nom,genre\n1,A,X\n")).toThrow(/Genre/);
  });
});
