import { lang } from "../i18n.js";

/** Singulier pour 1 (et 0 en français, comme « 0 pilote ajouté »). */
export const one = (n: number) => n === 1 || (n === 0 && lang() === "fr");
