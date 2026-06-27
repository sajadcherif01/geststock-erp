# GestStock ERP - Mode hors stock

Application web autonome pour la gestion commerciale, ventes, achats, comptes clients/fournisseurs, paiements et analyses.

Cette branche `feature/remove-stock` bascule l ERP en mode hors stock : les ventes sont conservees comme lignes commerciales et ne generent plus de mouvements de stock.

Garanties : comptes clients conserves, calcul du solde inchange, historique conserve, rollback SQL fourni.
