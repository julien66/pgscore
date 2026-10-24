import type { FC } from "hono/jsx";
import { type Task } from "@pgscore/engine";
import type { PilotRow } from "../db.js";
import { locale, t } from "../i18n.js";
import { Bi } from "./layout.js";

/** Un paramètre sur sa ligne : libellé et phrase d'explication à gauche, champ à droite. */
export const Param: FC<{ id: string; label: string; help: string; formula?: string; children: unknown }> = ({ id, label, help, formula, children }) => (
  <div class="param">
    <div>
      <label for={id}>{label}</label>
      <p class="small muted">{help}</p>
      {formula ? <p class="formula">{formula}</p> : null}
    </div>
    {children}
  </div>
);

/** Colonnes d'identité des classements (genre, nation, matériel, sponsor), affichées si le registre les renseigne. */
export const identity = (registry: PilotRow[], keys: string[]) => {
  const reg = new Map(registry.map((p) => [p.pilot_key, p]));
  const of = (k: string) => reg.get(k);
  const glider = (x: PilotRow | undefined) => [x?.glider_brand, x?.glider_model].filter(Boolean).join(" ");
  const harness = (x: PilotRow | undefined) => [x?.harness_brand, x?.harness_model].filter(Boolean).join(" ");
  const gear = (x: PilotRow | undefined) => glider(x) || harness(x);
  const has = (f: (x: PilotRow | undefined) => unknown) => keys.some((k) => Boolean(f(of(k))));
  const show = { gender: has((x) => x?.gender), nation: has((x) => x?.nation), gear: has(gear), sponsor: has((x) => x?.sponsor) };
  const Head: FC = () => (
    <>
      {show.gender ? <th>{t("Genre")}</th> : null}
      {show.nation ? <th>{t("Nat.")}</th> : null}
      {show.gear ? <th>{t("Matériel")}</th> : null}
      {show.sponsor ? <th>{t("Sponsor")}</th> : null}
    </>
  );
  const Cells: FC<{ k: string }> = ({ k }) => {
    const x = of(k);
    return (
      <>
        {show.gender ? <td>{x?.gender ?? ""}</td> : null}
        {show.nation ? <td>{x?.nation ?? ""}</td> : null}
        {show.gear ? (
          <td class="small gear" title={x?.glider_class ?? ""}>
            {glider(x)}
            {harness(x) ? <div class="muted">{harness(x)}</div> : null}
          </td>
        ) : null}
        {show.sponsor ? <td class="small sponsor">{x?.sponsor ?? ""}</td> : null}
      </>
    );
  };
  /** Nom de l'inscrit sous ce numéro, sinon celui de la trace. */
  const nameOf = (k: string, fallback: string) => of(k)?.name ?? fallback;
  return { Head, Cells, nameOf };
};

/** Lien d'export CSV, présenté comme le bouton d'impression, avec une icône de tableur. */
export const CsvLink: FC<{ href: string }> = ({ href }) => (
  <a class="act" href={href} title={t("Télécharger le tableau (CSV, ouvrable dans Excel)")}>
    <Bi n="sheet" /> {t("Exporter en CSV")}
  </a>
);

/** Bouton d'impression du classement affiché : détail déplié, ajusté à une page A4 portrait (competition.js). */
export const PrintButton: FC = () => (
  <button type="button" class="link print-rk" title={t("Imprimer ou enregistrer en PDF (A4 portrait, détail déplié)")}>
    <Bi n="printer" /> {t("Imprimer / PDF")}
  </button>
);

/** Bascule version courte / version complète (colonnes .sp), posée en haut et en bas à droite du tableau. */
export const SportToggle: FC<{ csv?: string }> = ({ csv }) => (
  <div class="rk-bar">
    {csv ? (
      <span class="acts">
        <CsvLink href={csv} />
        <PrintButton />
      </span>
    ) : null}
    <button type="button" class="link sp-toggle" title={t("Afficher ou masquer le détail sportif")}>
      <span class="sp-closed">{t("Version complète")}</span>
      <span class="sp-open">{t("Version courte")}</span>
    </button>
  </div>
);

export const TotalHead: FC = () => <th class="n">{t("Total")}</th>;

export const fr = (v: number, digits: number) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const pts = (v: number | null | undefined) => (v === null || v === undefined ? "" : fr(v, 1));

/** Classement de la manche, présenté comme les résultats publiés : rang, pilote, voile, temps, points. */
/** Altitude publiée du goal (AMSL), pour afficher les passages de l'elevated goal en hauteur au-dessus du goal. */
export const goalAltitudeOf = (task: Task): number => task.turnpoints.at(-1)?.zone.waypoint.altitude ?? 0;
