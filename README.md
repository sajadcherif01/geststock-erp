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

GestStock peut utiliser Supabase comme base professionnelle temps reel. GitHub Pages heberge l'interface, Supabase stocke les donnees.

Comptes par defaut :

- Admin : `admin` / `1234`
- Visiteur : `visiteur` / `0000`

Le mode Admin peut modifier les donnees. Le mode Visiteur peut consulter et imprimer.

Configuration Supabase :

1. Creer un projet Supabase.
2. Ouvrir `SQL Editor`.
3. Executer le fichier `docs/supabase-schema.sql`.
4. Copier `Project URL` et `anon public key`.
5. Dans GestStock : `Base donnees > Utilisateurs > Synchronisation Supabase temps reel`.
6. Coller URL + anon key, puis cliquer `Activer Supabase`.

Une fois configure, chaque modification Admin est sauvegardee dans Supabase, et les autres appareils recoivent la mise a jour en temps reel.

## Fichiers

- `index.html` : application complete.
- `docs/GestStock_Documentation_FR.html` : documentation source en francais.
- `docs/GestStock_Documentation_FR.pdf` : schema detaille en PDF.
