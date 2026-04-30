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

## Stockage des donnees

GestStock utilise le stockage local du navigateur (`localStorage`). Les donnees restent dans le navigateur de l'utilisateur. Il faut utiliser la fonction d'export de sauvegarde avant de changer de navigateur, vider le cache ou migrer vers un autre poste.

## Fichiers

- `index.html` : application complete.
- `docs/GestStock_Documentation_FR.html` : documentation source en francais.
- `docs/GestStock_Documentation_FR.pdf` : schema detaille en PDF.
