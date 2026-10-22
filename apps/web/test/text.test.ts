import { describe, expect, it } from "vitest";
import { csvCell, decodeEntities, decodeFsName, parseCsvRows, toCsv } from "../src/text.js";

describe("outils de texte partagés", () => {
  it("écrit et relit un CSV", () => {
    const csv = toCsv([["nom", "note"], ["Dupont, Jean", 'dit "JD"'], [null, 3]]);
    expect(csv).toBe('nom,note\n"Dupont, Jean","dit ""JD"""\n,3\n');
    expect(parseCsvRows(csv)).toEqual([["nom", "note"], ["Dupont, Jean", 'dit "JD"'], ["", "3"]]);
    expect(csvCell("a;b")).toBe('"a;b"');
  });

  it("devine le séparateur et ignore le BOM", () => {
    expect(parseCsvRows("﻿a;b\r\n1;2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("décode les entités nommées et numériques, et laisse les autres", () => {
    expect(decodeEntities("A&amp;B &Eacute; &#233;&#xE9; &nbsp;&lt;x&gt; &#99999999;")).toBe("A&B &Eacute; éé  <x> &#99999999;");
  });

  it("redécode les accents des noms de fichiers FS", () => {
    expect(decodeFsName("M#U00fcller.igc")).toBe("Müller.igc");
  });
});
