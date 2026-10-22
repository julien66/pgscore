/** Petit lecteur et écrivain XML, suffisant pour les fichiers FSDB (éléments, attributs, CDATA). */
import { decodeEntities } from "./text.js";

export interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  /** Texte et CDATA mis bout à bout. */
  text: string;
}

export const decodeXml = decodeEntities;
export const encodeXml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/\r?\n/g, "&#13;&#10;");

export class XmlError extends Error {}

export function parseXml(src: string): XmlEl {
  const root: XmlEl = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlEl[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  for (const m of src.replace(/^﻿/, "").matchAll(re)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (top.name !== m[2]) throw new XmlError(`Balise fermante </${m[2]}> inattendue (ouverte : <${top.name}>).`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const el: XmlEl = { name: m[3], attrs: {}, children: [], text: "" };
      for (const a of (m[4] ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1]!] = decodeXml(a[2] ?? a[3] ?? "");
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += decodeXml(m[6]);
    else if (m[7] !== undefined) throw new XmlError("XML illisible : « < » isolé.");
  }
  if (stack.length !== 1) throw new XmlError(`Balise <${stack[stack.length - 1]!.name}> non fermée.`);
  return root;
}

export const child = (el: XmlEl | undefined, name: string): XmlEl | undefined => el?.children.find((c) => c.name === name);
export const children = (el: XmlEl | undefined, name: string): XmlEl[] => el?.children.filter((c) => c.name === name) ?? [];

/** Écriture : élément avec attributs (valeurs null/undefined omises) et enfants déjà écrits. */
export function el(name: string, attrs: Record<string, string | number | boolean | null | undefined>, kids: string[] = []): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${encodeXml(String(v))}"`)
    .join("");
  if (!kids.length) return `<${name}${a} />`;
  const inner = kids.map((k) => k.split("\r\n").map((l) => `  ${l}`).join("\r\n")).join("\r\n");
  return `<${name}${a}>\r\n${inner}\r\n</${name}>`;
}

/** Bloc CDATA (texte libre, comme les notes de la compétition). */
export const cdata = (name: string, text: string) => `<${name}><![CDATA[${text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></${name}>`;
