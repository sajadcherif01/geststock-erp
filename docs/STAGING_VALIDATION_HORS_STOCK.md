# Validation staging - Mode hors stock

Objectif: valider la branche `feature/remove-stock` avant toute fusion vers `main` et avant toute execution SQL production.

## 1. Preparation

- Ne pas executer les scripts SQL en production.
- Creer ou utiliser un projet Supabase staging.
- Restaurer une copie des donnees dans staging.
- Configurer l application staging avec l URL et la cle anon du projet staging.

## 2. Tests fonctionnels obligatoires

### Vente / bon
- Creer une vente avec client, article, couleur, longueur, largeur, quantite, prix m2.
- Verifier surface et total.
- Confirmer la vente.
- Verifier que la vente apparait dans l historique.
- Verifier qu aucun controle de stock disponible n apparait.

### Compte client
- Ouvrir le compte du client utilise.
- Verifier que la vente augmente le total operations comme avant.
- Ajouter un paiement client.
- Verifier que le solde restant est correct.
- Imprimer ou generer le PDF du compte client.

### Historique
- Verifier que les ventes historiques restent visibles.
- Verifier que les achats historiques restent visibles.
- Verifier que les paiements historiques restent visibles.

### Modules retires
- Verifier que Stock, Import Stock, Transfert intersite et Remise a zero stock ne sont plus accessibles depuis la navigation.

## 3. Migration SQL staging

Executer dans cet ordre uniquement sur staging:

1. `docs/sql/backup-before-hors-stock.sql`
2. `docs/sql/migration-hors-stock.sql`

Puis refaire tous les tests fonctionnels.

## 4. Rollback staging

Si un probleme apparait:

1. Executer `docs/sql/rollback-hors-stock.sql`
2. Recharger l application.
3. Verifier les comptes clients et l historique.

## 5. Production

Production autorisee seulement apres validation utilisateur explicite:

- PR relue et mergee.
- Backup Supabase complet exporte.
- Migration testee en staging.
- Rollback teste en staging.