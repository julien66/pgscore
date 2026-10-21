#!/usr/bin/env python3
"""Nettoie un .fsdb de FS de ses données personnelles avant de le publier comme donnée de test.

Ne garde des attributs personnalisés des pilotes (FsCustomAttribute) que le nom, la nationalité et le
matériel, et retire la date de naissance et la licence FAI des FsParticipant. Tout le reste (manches,
formule, résultats FS) est recopié tel quel, au caractère près.

    scripts/clean-fsdb.py entree.fsdb sortie.fsdb

Le script échoue s'il reste une adresse e-mail ou un numéro de téléphone dans le résultat.
"""
import re
import sys

KEEP = {
    "First name",
    "Last name",
    "Nationality",
    "Wing Model",
    "Wing Manufacturer",
    "PG Certification",
    "Harness Model",
    "Harness Manufacturer",
    "GCat",
}
DROP_ATTRS = ("birthday", "fai_licence")
EMAIL = r"[\w.+-]+@[\w-]+\.[\w.-]+"
PHONE = r"\+\d[\d .]{7,}"


def clean(text: str) -> str:
    def custom(m: re.Match) -> str:
        name = re.search(r'\bname="([^"]*)"', m.group(0))
        return m.group(0) if name and name.group(1) in KEEP else ""

    # Un attribut par ligne dans les fichiers FS : on retire la ligne entière.
    text = re.sub(r"[ \t]*<FsCustomAttribute\s[^>]*/>[ \t]*\r?\n?", custom, text)
    for attr in DROP_ATTRS:
        text = re.sub(rf'\s{attr}="[^"]*"', "", text)
    # Adresse glissée dans un champ libre (sponsor…).
    return re.sub(EMAIL, "", text)


def check(text: str) -> None:
    leaks = re.findall(EMAIL, text) + re.findall(PHONE, text)
    if leaks:
        sys.exit(f"Données personnelles restantes : {len(leaks)} (ex. {leaks[0][:3]}…)")


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8", newline="") as f:
        text = clean(f.read())
    check(text)
    with open(dst, "w", encoding="utf-8", newline="") as f:
        f.write(text)


if __name__ == "__main__":
    main()
