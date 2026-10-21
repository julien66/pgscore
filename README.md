# Données de test

Branche sans historique commun avec `main` : grosses données de référence des tests de bout en bout,
téléchargées par `scripts/fetch-test-tracks.sh` (adresse épinglée sur un commit, empreinte SHA-256 vérifiée).

| Fichier | Contenu |
|---|---|
| `fs/french-open-tdc-2026.zip` | French Open - Trophées des Cimes 2026 : ZIP FS (.fsdb + traces des 5 manches). Le .fsdb a été nettoyé par `scripts/clean-fsdb.py` : il ne garde des pilotes que le nom, la nation, le genre et le matériel (ni e-mail, ni téléphone, ni adresse, ni date de naissance, ni assurance, ni contact d'urgence). |
