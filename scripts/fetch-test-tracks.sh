#!/usr/bin/env bash
# Télécharge les traces IGC des manches PWCA de référence (publiques sur scoring.pwca.org) dans
# .test-data/, vérifie leur empreinte et les décompresse. Les tests de calcul PWCA les lisent via
# GEMONA_T3_IGC_DIR, FELTRE_T3_IGC_DIR et PWCA_T1_IGC_DIR.
#
#   scripts/fetch-test-tracks.sh            # télécharge ce qui manque
#   eval "$(scripts/fetch-test-tracks.sh --env)"   # et exporte les variables dans le shell
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.test-data"
BASE="https://scoring.pwca.org"

# dossier | adresse | empreinte SHA-256 du zip
SETS=(
  "gemona-2026-t3|$BASE/gemona-2026/T3/T3_2026-07-28.zip|8675b797beb7e789e24ae8e0b44c681548b5e1f35529f8a943aa969ad6d968ee"
  "feltre-2025-t3|$BASE/feltre-2025/T3/T3_2025-07-01.zip|879ae39dd45f52dfafd518d8a1bbb16fc9b247c0d70fc1686e480b4fa4b9b541"
  "baixo-guandu-2026-t1|$BASE/baixo-guandu-2026/T1/T1_2026-10-05.zip|8ae975b938d9dc4cb88ba19dfaf9783bfec348d575b65abf17f78bfa61afab7b"
)

mkdir -p "$DATA"
for set in "${SETS[@]}"; do
  IFS="|" read -r name url sha <<<"$set"
  dir="$DATA/$name"
  if [ -f "$dir/.ok" ]; then continue; fi
  zip="$DATA/$name.zip"
  if [ ! -f "$zip" ] || ! echo "$sha  $zip" | sha256sum -c --status; then
    echo "Téléchargement de $url" >&2
    curl -fsSL --retry 4 --retry-delay 2 -o "$zip" "$url"
    echo "$sha  $zip" | sha256sum -c --status || { echo "Empreinte inattendue pour $url" >&2; exit 1; }
  fi
  rm -rf "$dir" && mkdir -p "$dir"
  unzip -q -o "$zip" -d "$dir"
  touch "$dir/.ok"
done

if [ "${1:-}" = "--env" ]; then
  echo "export GEMONA_T3_IGC_DIR='$DATA/gemona-2026-t3'"
  echo "export FELTRE_T3_IGC_DIR='$DATA/feltre-2025-t3'"
  echo "export PWCA_T1_IGC_DIR='$DATA/baixo-guandu-2026-t1'"
fi
