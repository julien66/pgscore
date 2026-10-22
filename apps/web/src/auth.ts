import { createHash, randomBytes } from "node:crypto";
import type { Db, User } from "./db.js";
import { t } from "./i18n.js";
import { queryAll, queryOne } from "./repo.js";

/**
 * Connexion par un service externe (OpenID Connect, Google par défaut). Aucun mot de passe n'est
 * stocké : on garde l'identifiant du compte chez le fournisseur, son e-mail et son nom.
 *
 * Le jeton d'identité est reçu directement du fournisseur, par HTTPS, en échange du code
 * d'autorisation (flux « code » avec PKCE) : d'après OpenID Connect Core 3.1.3.7, la validation TLS
 * du serveur suffit alors à l'authentifier, sans vérifier sa signature. On contrôle l'émetteur,
 * le destinataire, l'expiration et le nonce.
 */

export interface OidcConfig {
  /** Nom court du fournisseur, enregistré avec chaque compte ("google"). */
  provider: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Adresse publique de l'appli, sans « / » final, ex. https://score.example.org */
  baseUrl: string;
}

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const SESSION_COOKIE = "pgscore_session";
const SESSION_DAYS = 30;

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  issuer: string;
}

const discoveries = new Map<string, Promise<Discovery>>();
function discover(issuer: string): Promise<Discovery> {
  let d = discoveries.get(issuer);
  if (!d) {
    d = fetch(`${issuer}/.well-known/openid-configuration`).then(async (r) => {
      if (!r.ok) throw new Error(t("Découverte OpenID impossible ({status})", { status: r.status }));
      return (await r.json()) as Discovery;
    });
    d.catch(() => discoveries.delete(issuer));
    discoveries.set(issuer, d);
  }
  return d;
}

const b64url = (b: Buffer) => b.toString("base64url");
export const callbackPath = "/auth/callback";

/** Adresse du fournisseur où envoyer l'utilisateur pour qu'il se connecte. */
export async function loginUrl(db: Db, cfg: OidcConfig): Promise<string> {
  const d = await discover(cfg.issuer);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  db.prepare("DELETE FROM login_states WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO login_states (state, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)").run(
    state,
    verifier,
    nonce,
    Date.now() + 10 * 60_000,
  );
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.baseUrl + callbackPath,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return u.toString();
}

/** Retour du fournisseur : échange du code contre l'identité, puis création ou mise à jour du compte. */
export async function handleCallback(db: Db, cfg: OidcConfig, code: string, state: string): Promise<User> {
  const st = db.prepare("SELECT verifier, nonce, expires_at FROM login_states WHERE state = ?").get(state) as
    | { verifier: string; nonce: string; expires_at: number }
    | undefined;
  db.prepare("DELETE FROM login_states WHERE state = ?").run(state);
  if (!st || st.expires_at < Date.now()) throw new Error(t("Demande de connexion expirée, recommencez."));

  const d = await discover(cfg.issuer);
  const r = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.baseUrl + callbackPath,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: st.verifier,
    }),
  });
  if (!r.ok) throw new Error(t("Le fournisseur a refusé la connexion ({status}).", { status: r.status }));
  const tok = (await r.json()) as { id_token?: string };
  if (!tok.id_token) throw new Error(t("Pas de jeton d'identité dans la réponse."));
  const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    iss: string;
    aud: string | string[];
    exp: number;
    sub: string;
    nonce?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  const issuers = [d.issuer, cfg.issuer, cfg.issuer.replace(/^https:\/\//, "")];
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!issuers.includes(claims.iss)) throw new Error(t("Émetteur du jeton inattendu."));
  if (!aud.includes(cfg.clientId)) throw new Error(t("Jeton destiné à une autre application."));
  if (claims.exp * 1000 < Date.now()) throw new Error(t("Jeton expiré."));
  if (claims.nonce !== st.nonce) throw new Error(t("Jeton rejoué ou altéré."));
  return upsertUser(db, cfg.provider, claims.sub, claims.email_verified === false ? null : (claims.email ?? null), claims.name ?? null);
}

export function upsertUser(db: Db, provider: string, subject: string, email: string | null, name: string | null): User {
  db.prepare(
    `INSERT INTO users (provider, subject, email, name, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, name = excluded.name`,
  ).run(provider, subject, email, name, Date.now());
  return queryOne<User>(db, "SELECT id, provider, subject, email, name FROM users WHERE provider = ? AND subject = ?", provider, subject)!;
}

export function createSession(db: Db, userId: number): { token: string; maxAge: number } {
  const token = b64url(randomBytes(32));
  const maxAge = SESSION_DAYS * 86_400;
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), userId, Date.now() + maxAge * 1000);
  return { token, maxAge };
}

export function sessionUser(db: Db, token: string | undefined): User | null {
  if (!token) return null;
  const row = queryOne<User>(db, `SELECT u.id, u.provider, u.subject, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`, hashToken(token), Date.now());
  return row ?? null;
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
}

/** On ne stocke que l'empreinte du jeton de session : une copie de la base ne donne pas accès aux comptes. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// --- Clés d'API ------------------------------------------------------------------------------

export interface ApiTokenRow {
  id: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

/** Crée une clé d'API pour l'utilisateur. La clé n'est montrée qu'une fois : seule son empreinte est gardée. */
export function createApiToken(db: Db, userId: number, name: string): string {
  const token = `pgs_${b64url(randomBytes(30))}`;
  db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(userId, name, hashToken(token), Date.now());
  return token;
}

export function listApiTokens(db: Db, userId: number): ApiTokenRow[] {
  return queryAll<ApiTokenRow>(db, "SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC", userId);
}

export function deleteApiToken(db: Db, userId: number, id: number): void {
  db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(id, userId);
}

/** Utilisateur d'une clé d'API (en-tête « Authorization: Bearer pgs_… »). */
export function apiTokenUser(db: Db, token: string): User | null {
  const hash = hashToken(token);
  const row = queryOne<User>(db, "SELECT u.id, u.provider, u.subject, u.email, u.name FROM api_tokens k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?", hash);
  if (row) db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?").run(Date.now(), hash);
  return row ?? null;
}
