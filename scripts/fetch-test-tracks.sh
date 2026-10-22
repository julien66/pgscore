#!/usr/bin/env bash
# Télécharge les traces IGC des manches PWCA de référence (publiques sur scoring.pwca.org) dans
# .test-data/, vérifie leur empreinte et les décompresse. Les tests de calcul PWCA les lisent via
# GEMONA_T3_IGC_DIR, FELTRE_T3_IGC_DIR, PWCA_T1_IGC_DIR et SOPOT_T1_IGC_DIR … SOPOT_T4_IGC_DIR.
# Télécharge aussi les ZIP gardés tels quels (compétitions de la branche test-data du dépôt), lus via
# TDC_2026_ZIP et GERMAN_OPEN_2026_ZIP.
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
  "sopot-2026-t1|$BASE/sopot-2026/T1/T1_2026-09-07.zip|00916874f8f1e237dfcd1ccba7d3e0c4c66fc402c327aa2a23b8136ee3bab517"
  "sopot-2026-t2|$BASE/sopot-2026/T2/T2_2026-09-08.zip|92e51381350a36ca40111837d69250abc16837d9daf4ddab600207a841607b85"
  "sopot-2026-t3|$BASE/sopot-2026/T3/T3_2026-09-10.zip|df5d1c03b991f1952bb612b134db32771b36923856479561a32deae16d83128d"
  "sopot-2026-t4|$BASE/sopot-2026/T4/T4_2026-09-11.zip|ae713b271379733070189eda7af83341bc33b19224c4453f0388d0876fee9f2e"
)

# ZIP gardés tels quels : fichier | adresse (épinglée sur un commit de la branche test-data) | empreinte
TEST_DATA="https://raw.githubusercontent.com/julien66/pgscore/73638b06bd3ceda0b62dc8a49f7e5c502695dcf0"
ZIPS=(
  "french-open-tdc-2026.zip|$TEST_DATA/fs/french-open-tdc-2026.zip|dea79c130418d59d3644bcf84b1f132922dacacbee1cc55176585faaa261fb41"
  "german-open-2026.zip|$TEST_DATA/civlcomps/german-open-2026.zip|c2beeb922e434f79cd086ce11fd5615a22af564e06272cea14d81c3a3387abc5"
)

mkdir -p "$DATA"
for set in "${ZIPS[@]}"; do
  IFS="|" read -r name url sha <<<"$set"
  zip="$DATA/$name"
  if [ -f "$zip" ] && echo "$sha  $zip" | sha256sum -c --status; then continue; fi
  echo "Téléchargement de $url" >&2
  curl -fsSL --retry 4 --retry-delay 2 -o "$zip" "$url"
  echo "$sha  $zip" | sha256sum -c --status || { echo "Empreinte inattendue pour $url" >&2; exit 1; }
done

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
  for n in 1 2 3 4; do echo "export SOPOT_T${n}_IGC_DIR='$DATA/sopot-2026-t$n'"; done
  echo "export TDC_2026_ZIP='$DATA/french-open-tdc-2026.zip'"
  echo "export GERMAN_OPEN_2026_ZIP='$DATA/german-open-2026.zip'"
fi
