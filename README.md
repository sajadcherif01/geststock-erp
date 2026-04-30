# GestStock ERP V4

Application web autonome pour la gestion de stock, achats, ventes, transferts, comptes clients/fournisseurs, inventaires et analyses.

## Publication GitHub Pages

Le fichier principal de l'application est `index.html`. Pour publier avec GitHub Pages :

1. Creer un depot GitHub public ou prive nomme par exemple `geststock-erp`.
2. Ajouter `index.html`, `README.md` et le dossier `docs`.
3. Aller dans `Settings > Pages`.
4. Choisir `Deploy from a branch`.
5. Choisir la branche `main` et le dossier `/root`.
6. Enregistrer.

L'application sera disponible a l'adresse :

`https://sajadcherif01.github.io/geststock-erp/`

## Stockage et synchronisation

GestStock utilise un fichier central `data/geststock-db.json` pour synchroniser les donnees entre PC et telephone via GitHub Pages.

Comptes par defaut :

- Admin : `admin` / `1234`
- Visiteur : `visiteur` / `0000`

Le mode Admin peut modifier les donnees. Le mode Visiteur peut consulter et imprimer.

Important : pour sauvegarder les modifications depuis l'application vers GitHub, l'admin doit renseigner un token GitHub fine-grained avec acces `Contents: Read and write` au depot. Sans token, l'application peut lire la base GitHub mais ne peut pas ecrire dedans.

## Fichiers

- `index.html` : application complete.
- `docs/GestStock_Documentation_FR.html` : documentation source en francais.
- `docs/GestStock_Documentation_FR.pdf` : schema detaille en PDF.
