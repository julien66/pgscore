import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { dirname, join } from "node:path";
import { openDb } from "./db.js";
import { TrackStore } from "./track-store.js";

/**
 * Lancement : PORT (3000), BASE_URL (http://localhost:PORT), DATABASE_PATH (data/pgscore.db),
 * TRACKS_DIR (dossier « tracks » à côté de la base) pour les fichiers IGC,
 * GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET pour la connexion Google, DEV_LOGIN=1 pour une
 * connexion de test sans fournisseur (jamais en production).
 */
const port = Number(process.env.PORT ?? 3000);
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const dbPath = process.env.DATABASE_PATH ?? "data/pgscore.db";
const tracks = new TrackStore(process.env.TRACKS_DIR ?? join(dirname(dbPath), "tracks"));
const db = openDb(dbPath, tracks);
const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
    : undefined;
const devLogin = process.env.DEV_LOGIN === "1";

const app = createApp(db, tracks, { baseUrl, ...(google ? { google } : {}), devLogin, secureCookies: baseUrl.startsWith("https://") });
serve({ fetch: app.fetch, port }, () => {
  console.log(`pgscore sur ${baseUrl}`);
  if (google) console.log(`Connexion Google : adresse de retour à déclarer ${baseUrl}/auth/callback`);
  else console.log("Connexion Google non configurée (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).");
  if (devLogin) console.log("Attention : connexion de développement active (DEV_LOGIN=1).");
});
