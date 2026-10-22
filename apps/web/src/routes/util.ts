import { lang } from "../i18n.js";

/** Singulier pour 1 (et 0 en français, comme « 0 pilote ajouté »). */
export const one = (n: number) => n === 1 || (n === 0 && lang() === "fr");

/** Envoi de traces IGC (fichiers ou ZIP). */
export const MAX_UPLOAD = 200 * 1024 * 1024;
/** Import d'une compétition (archive pgscore ou FSDB avec ses traces). */
export const MAX_IMPORT = 1024 * 1024 * 1024;
/** Tout autre formulaire (réglages, espaces aériens, liste des pilotes, définition de manche). */
export const MAX_FORM = 20 * 1024 * 1024;

/** Limite propre aux envois de traces et aux imports, qui vérifient eux-mêmes la taille annoncée. */
export function uploadLimit(path: string): number | null {
  if (/^\/(api\/)?competitions\/import$/.test(path)) return MAX_IMPORT;
  if (/^\/tasks\/\d+\/tracks(\/\d+\/replace)?$/.test(path)) return MAX_UPLOAD;
  return null;
}
