# Données de test

Branche sans historique commun avec `main` : grosses données de référence des tests de bout en bout,
téléchargées par `scripts/fetch-test-tracks.sh` (adresse épinglée sur un commit, empreinte SHA-256 vérifiée).

| Fichier | Contenu |
|---|---|
| `fs/french-open-tdc-2026.zip` | French Open - Trophées des Cimes 2026 : ZIP FS (.fsdb + traces des 5 manches). Le .fsdb a été nettoyé par `scripts/clean-fsdb.py` : il ne garde des pilotes que le nom, la nation, le genre et le matériel (ni e-mail, ni téléphone, ni adresse, ni date de naissance, ni assurance, ni contact d'urgence). |
| `civlcomps/german-open-2026.zip` | German Open 2026 : copie des 11 réponses de civlcomps.org lues par l'import (page de résultats, pages des 5 manches, ZIP de traces), avec `index.json` (adresse → fichier). Le ZIP de traces de la manche 1 (`002.zip`) est remplacé par le lot Flymaster de la manche, celui de civlcomps coupant les traces juste avant la ligne de goal. |
| `civlcomps/us-open-2026.zip` | US Open of Paragliding 2026 (Chelan) : copie des 7 réponses de civlcomps.org lues par l'import (page de résultats, pages des 3 manches, ZIP de traces), avec `index.json` (adresse → fichier). |
