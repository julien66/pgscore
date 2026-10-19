import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, sep } from "node:path";

/**
 * Bibliothèques de la vue des traces servies par l'appli elle-même (Leaflet pour la carte,
 * Cesium pour la 3D) : pas de dépendance à un CDN, l'appli marche sur un réseau fermé.
 */
const require = createRequire(import.meta.url);
const roots: Record<string, string> = {
  leaflet: dirname(require.resolve("leaflet")),
  cesium: join(dirname(require.resolve("cesium")), "Build", "Cesium"),
};

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".glb": "model/gltf-binary",
  ".ktx2": "image/ktx2",
};

export function vendorFile(lib: string, path: string): { body: Buffer; type: string } | null {
  const root = roots[lib];
  if (!root) return null;
  const file = normalize(join(root, path));
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
  return { body: readFileSync(file), type: TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" };
}
