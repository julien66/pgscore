import type { Context, Hono } from "hono";
import type { CompetitionRow, Db, TaskRow, User } from "../db.js";
import type { TrackStore } from "../track-store.js";

export interface AppConfig {
  baseUrl: string;
  google?: { clientId: string; clientSecret: string };
  /** Connexion sans fournisseur, pour le développement et les tests. */
  devLogin?: boolean;
  /** Cookies « Secure » (vrai dès que l'appli est servie en HTTPS). */
  secureCookies?: boolean;
  /** Adresses e-mail des administrateurs : ils modifient toutes les compétitions. */
  adminEmails?: string[];
}

export type Env = { Variables: { user: User | null } };
export type App = Hono<Env>;

/** Ce que les routes partagent : base, traces, configuration, et les contrôles d'accès posés par createApp. */
export interface Ctx {
  db: Db;
  tracks: TrackStore;
  cfg: AppConfig;
  /** Utilisateur connecté, sur les routes qui l'exigent. */
  me: (c: Context<Env>) => User;
  competition: (c: Context<Env>, id: string) => CompetitionRow | null;
  isAdmin: (u: User) => boolean;
  canEdit: (c: Context<Env>, comp: CompetitionRow) => boolean;
  taskOf: (c: Context<Env>, id: string) => { t: TaskRow; comp: CompetitionRow } | null;
  notFound: (c: Context<Env>) => Response | Promise<Response>;
}
