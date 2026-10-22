/**
 * Globales des scripts du navigateur (src/static/*.js), vérifiés par tsconfig.static.json :
 * traductions servies par /static/i18n.js, Leaflet et Cesium chargés par leurs propres balises.
 */

/** Traduction d'un texte de l'interface, avec ses paramètres {nom}. */
declare function T(s: string, p?: Record<string, unknown>): string;

/** Leaflet (vendor/leaflet), sans ses types. */
declare const L: any;

/** Fonds de carte communs à la carte 2D et à la vue 3D (basemaps.js). */
declare const pgBasemaps: any;

interface Window {
  I18N_LANG: string;
  I18N_LOCALE: string;
  I18N: Record<string, string>;
  T: typeof T;
  L: any;
  pgBasemaps: any;
  Cesium: any;
  CESIUM_BASE_URL: string;
}
