import type { FC } from "hono/jsx";
import type { User } from "./db.js";
import { N_, t } from "./i18n.js";
import { Layout } from "./pages/layout.js";

/**
 * Page publique « Différences CIVL / PWCA » : chaque différence de calcul entre la formule CIVL (FS) et la
 * formule PWCA (SVL), avec le test unitaire qui l'isole (packages/engine/test/differences-civl-pwca.test.ts)
 * et les tests sur compétitions réelles qui la confirment. Le test web differences.test.ts vérifie que chaque
 * test cité existe.
 */

export const REPO = "https://github.com/julien66/pgscore";
export const UNIT_TEST_FILE = "packages/engine/test/differences-civl-pwca.test.ts";

export interface Proof {
  /** Fichier de test, depuis la racine du dépôt. */
  file: string;
  label: string;
}

export interface Difference {
  id: string;
  title: string;
  civl: string;
  pwca: string;
  effect: string;
  /** Titres exacts des tests unitaires (it) de UNIT_TEST_FILE, en français comme dans le code. */
  unitTests: string[];
  proofs: Proof[];
}

const SOPOT: Proof = { file: "packages/engine/test/sopot-2026.test.ts", label: N_("PWC Sopot 2026 : 4 manches et classement général (SVL)") };
const GAP_PWCA: Proof = { file: "packages/engine/test/gap-pwca.test.ts", label: N_("Points GAP de Gemona 2026, Feltre 2025 et Baixo Guandu 2026 (SVL)") };
const TDC: Proof = { file: "apps/web/test/tdc-2026.test.ts", label: N_("French Open - Trophées des Cimes 2026 : 5 manches et classement général (FS)") };

export const DIFFERENCES: Difference[] = [
  {
    id: "D1",
    title: N_("Tolérance des cylindres"),
    civl: N_("0 % du rayon : 5 m seulement (S7F 2026, 9.1.1)."),
    pwca: N_("0,1 % du rayon, la règle d'avant 2026, pour valider les balises comme pour mesurer les distances (route optimisée, distance restante)."),
    effect: N_("Sur une balise de 60 km, 60 m de marge au lieu de 5 m. À Sopot 2026 (manche 2), 7 pilotes passés à 28 à 86 m d'un cylindre de 132,8 km valident la balise en PWCA. Les distances de manche PWCA sont 40 à 110 m plus courtes."),
    unitTests: ["D1 un pilote à 30 m d'une balise de 60 km la valide en PWCA, pas en CIVL", "D1 la même tolérance raccourcit la distance de la manche"],
    proofs: [{ file: "packages/engine/test/distances.test.ts", label: N_("Six manches de Baixo Guandu 2026 : distances PWCA retrouvées à 25 m près avec 0,1 %") }, SOPOT],
  },
  {
    id: "D2",
    title: N_("Poids de la distance"),
    civl: N_("0,9 − 1,665·G + 1,713·G² − 0,587·G³, avec G le taux de goal (S7F 2026, 11)."),
    pwca: N_("0,9 − 1,67·G + 1,71·G² − 0,59·G³ : les mêmes coefficients, arrondis."),
    effect: N_("Moins d'un point de pourcentage sur la part de la distance, soit quelques points sur une manche à 1000 points."),
    unitTests: ["D2 les coefficients diffèrent et décalent le poids de la distance de moins d'un point de pourcentage"],
    proofs: [GAP_PWCA],
  },
  {
    id: "D3",
    title: N_("Leading Time Ratio par défaut"),
    civl: N_("26 % (S7F 2026, 11)."),
    pwca: N_("26,3158 %."),
    effect: N_("Quand des pilotes sont au goal, un peu plus de points pour le leading et un peu moins pour le temps."),
    unitTests: ["D3 sans LTR saisi pour la manche, chaque formule prend le sien"],
    proofs: [GAP_PWCA],
  },
  {
    id: "D4",
    title: N_("Meilleur temps"),
    civl: N_("Le plus rapide des pilotes arrivés au goal (S7F 2026, 9.4.1)."),
    pwca: N_("Le plus rapide des pilotes arrivés à l'ESS, au goal ou non (SVL : « Best time from goal = false »)."),
    effect: N_("Un pilote qui passe l'ESS vite mais se pose avant le goal fixe le meilleur temps en PWCA : les pilotes au goal ont moins de points de temps, et la validité de temps change."),
    unitTests: ["D4 un pilote plus rapide à l'ESS mais posé avant le goal donne le meilleur temps en PWCA seulement"],
    proofs: [GAP_PWCA],
  },
  {
    id: "D5",
    title: N_("Taux de goal"),
    civl: N_("Tous les pilotes au goal, divisés par les pilotes qui ont décollé (S7F 2026, 11)."),
    pwca: N_("Seulement les pilotes au goal qui marquent des points de temps (SVL : « Goal ratio from time points »)."),
    effect: N_("Un pilote arrivé au goal trop tard pour marquer du temps ne compte pas, et la part de la distance augmente. Trouvé sur la manche 1 de Sopot 2026."),
    unitTests: ["D5 un pilote arrivé au goal trop tard pour marquer du temps ne compte pas dans le taux de goal PWCA"],
    proofs: [SOPOT],
  },
  {
    id: "D6",
    title: N_("Section de vitesse du leading"),
    civl: N_("Celle de la route optimisée complète, depuis le décollage."),
    pwca: N_("La plus courte depuis n'importe quel point du bord du départ, sans tolérance (SVL : « Speed Section distance (shortest) »)."),
    effect: N_("Le coefficient de leading en dépend directement. Sopot 2026, manche 4 : 50,22 km contre 51,55 km par la route complète, jusqu'à 2 points d'écart. FS garde bien la route complète : 45,65 km et non 44,34 km sur la manche 4 du French Open 2026."),
    unitTests: ["D6 le LC se calcule sur 44 km en CIVL, 34 km en PWCA"],
    proofs: [SOPOT, TDC, { file: "packages/engine/test/leading-pwca.test.ts", label: N_("Points de leading de Baixo Guandu 2026, manche 1, à 0,1 point près (SVL)") }],
  },
  {
    id: "D7",
    title: N_("Manche arrêtée : fin de manche du leading"),
    civl: N_("L'heure d'arrêt, c'est-à-dire l'annonce moins le score-back (S7F 2026, 13.4)."),
    pwca: N_("En général l'heure d'annonce de l'arrêt (Feltre 2025), mais pas toujours : Sopot 2026 (manche 2) publie l'annonce moins le score-back. pgscore prend l'annonce par défaut, et l'heure de fin se règle manche par manche."),
    effect: N_("Les distances s'arrêtent au même moment dans les deux formules. Seule l'aire manquante des pilotes posés change, donc les points de leading."),
    unitTests: ["D7 maxTime vaut 55 min après la porte en CIVL, 60 min en PWCA"],
    proofs: [{ file: "packages/engine/test/stopped-feltre.test.ts", label: N_("Manche arrêtée de Feltre 2025 : distances et bonus d'altitude de 118 pilotes (SVL)") }, SOPOT],
  },
  {
    id: "D8",
    title: N_("Pénalités d'espace aérien"),
    civl: N_("En part du score : de 0 à 100 % des points, linéairement, entre 0 et 100 m d'infraction (S7A 2026, 6.3.1)."),
    pwca: N_("En points : 1000 × (1,05^p − 1) / (1,05^f − 1), au plus 1000, avec f = 100 m (soft) ou 50 m (hard). SVL arrondit au mètre les limites converties depuis les pieds."),
    effect: N_("À 50 m d'infraction : 80,2 points en PWCA soft, la moitié du score en CIVL. L'arrondi des limites change la profondeur de quelques décimètres."),
    unitTests: ["D8 50 m dans un espace : 80,2 points (PWCA soft), la moitié des points (S7A)"],
    proofs: [
      { file: "packages/engine/test/airspace-gemona.test.ts", label: N_("Espaces aériens de Gemona 2026, manche 3 : mêmes pilotes et mêmes pénalités (SVL)") },
      { file: "packages/engine/test/openair.test.ts", label: N_("Barèmes PWCA 2026 et S7A 2026") },
    ],
  },
];

/** Écart commun à FS et SVL par rapport au texte du S7F. */
export const COMMON: Difference = {
  id: "C1",
  title: N_("Coefficient de leading : FS et SVL d'accord, mais pas avec le texte du S7F"),
  civl: N_("FS : aire pondérée divisée par 1800 seulement."),
  pwca: N_("SVL : la même formule que FS."),
  effect: N_("Le texte du S7F 2026 (12.3.1) multiplie chaque tranche de l'aire de leading par la distance restante, et divise par 1800 × la distance de la section de vitesse. Aucun des deux logiciels ne le fait. pgscore les suit, puisque le texte donnerait des points de leading différents de tous les résultats publiés."),
  unitTests: ["C1 LC = Σ taskTime × ∫weight / 1800, sans facteur de distance"],
  proofs: [{ file: "packages/engine/test/leading-pwca.test.ts", label: N_("Points de leading de Baixo Guandu 2026, manche 1, à 0,1 point près (SVL)") }, TDC],
};

const fileUrl = (f: string) => `${REPO}/blob/main/${f}`;

const Tests: FC<{ d: Difference }> = ({ d }) => (
  <div class="dt">
    <div>
      <strong>{t("Test unitaire")}</strong> ·{" "}
      <a href={fileUrl(UNIT_TEST_FILE)}>
        <code>differences-civl-pwca.test.ts</code>
      </a>
      <ul>
        {d.unitTests.map((u) => (
          <li>
            <code>{u}</code>
          </li>
        ))}
      </ul>
    </div>
    <div>
      <strong>{t("Sur compétitions réelles")}</strong>
      <ul>
        {d.proofs.map((p) => (
          <li>
            <a href={fileUrl(p.file)}>{t(p.label)}</a> <span class="muted small">({p.file.split("/").pop()})</span>
          </li>
        ))}
      </ul>
    </div>
  </div>
);

const Card: FC<{ d: Difference; labels: [string, string] }> = ({ d, labels }) => (
  <div class="card" id={d.id}>
    <h2>
      <span class="did">{d.id}</span> {t(d.title)}
    </h2>
    <div class="pill2">
      <div>
        <h3>{labels[0]}</h3>
        <p>{t(d.civl)}</p>
      </div>
      <div>
        <h3>{labels[1]}</h3>
        <p>{t(d.pwca)}</p>
      </div>
    </div>
    <p>
      <strong>{t("Effet :")}</strong> {t(d.effect)}
    </p>
    <Tests d={d} />
  </div>
);

const CSS = `.diff .did{display:inline-block;min-width:34px;padding:1px 7px;margin-right:4px;border-radius:6px;background:var(--chip);font:600 14px ui-monospace,Menlo,monospace;text-align:center}
.diff h3{margin:4px 0;font-size:15px;color:var(--muted)}.diff .dt{display:flex;gap:16px;flex-wrap:wrap;font-size:14px}.diff .dt>div{flex:1 1 300px}
.diff .dt ul{margin:4px 0}.diff .dt code{white-space:normal}.diff table td{white-space:normal;vertical-align:top}`;

export const DifferencesPage: FC<{ user: User | null }> = ({ user }) => (
  <Layout title={t("Différences CIVL / PWCA")} user={user}>
    <style>{CSS}</style>
    <div class="about diff">
      <h1>{t("Différences de scoring CIVL / PWCA")}</h1>
      <p class="lead">
        {t("La CIVL (FAI) et la PWCA (Coupe du monde) appliquent toutes deux la formule GAP du Sporting Code S7F, mais pas tout à fait de la même façon. Les résultats CIVL sont calculés avec FS, ceux de la PWCA avec SVL. pgscore reproduit les deux : formule « CIVL GAP 2026 » ou « PWCA 2026 » dans les réglages de la compétition.")}
      </p>
      <p>
        {t("Les règles de SVL ne sont pas publiées : les différences ci-dessous ont été retrouvées en recalculant des compétitions réelles et en comparant nos points aux résultats officiels. Chacune est démontrée par un test que tout le monde peut relancer.")}
      </p>

      <div class="card">
        <h2>{t("En bref")}</h2>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>{t("Sujet")}</th>
                <th>{t("CIVL (FS)")}</th>
                <th>{t("PWCA (SVL)")}</th>
              </tr>
            </thead>
            <tbody>
              {DIFFERENCES.map((d) => (
                <tr>
                  <td>
                    <a href={`#${d.id}`}>{d.id}</a>
                  </td>
                  <td>{t(d.title)}</td>
                  <td>{t(d.civl)}</td>
                  <td>{t(d.pwca)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>{t("Reproduire")}</h2>
        <p>
          {t("Chaque différence a un test court, construit à la main, qui la montre seule. Des tests sur compétitions réelles montrent ensuite qu'elle suffit à retrouver les résultats publiés, au dixième de point près dans la plupart des cas.")}
        </p>
        <pre class="code">{`git clone ${REPO}.git && cd pgscore
pnpm install && pnpm --filter @pgscore/engine build
cd packages/engine && npx vitest run test/differences-civl-pwca.test.ts`}</pre>
        <p>{t("Les tests sur compétitions réelles ont besoin des traces des pilotes, publiques. Ce script les télécharge, puis tous les tests se lancent :")}</p>
        <pre class="code">{`eval "$(scripts/fetch-test-tracks.sh --env)"
pnpm test`}</pre>
      </div>

      {DIFFERENCES.map((d) => (
        <Card d={d} labels={[t("CIVL (FS)"), t("PWCA (SVL)")]} />
      ))}

      <h2>{t("Ce que FS et SVL font de la même façon")}</h2>
      <Card d={COMMON} labels={[t("CIVL (FS)"), t("PWCA (SVL)")]} />

      <div class="card">
        <h2>{t("Écarts que nous n'expliquons pas encore")}</h2>
        <ul>
          <li>{t("Sopot 2026, manche 3 : notre distance de manche fait 53,74 km, contre 53,70 km chez SVL, soit 0,8 point au plus par pilote. La méthode d'optimisation de la route de SVL n'est pas publiée.")}</li>
          <li>{t("Gemona 2026, manche 3, pilote 260 : un arc d'espace aérien mal fermé dans le fichier OpenAir est dessiné différemment, d'où 3,8 points de pénalité chez nous contre 1,8 chez SVL.")}</li>
        </ul>
        <p class="small muted">
          {t("Vous connaissez une autre différence, ou la raison d'un de ces écarts ? Ouvrez une issue :")} <a href={`${REPO}/issues`}>github.com/julien66/pgscore/issues</a>
        </p>
      </div>
    </div>
  </Layout>
);
