-- Rollback hors stock.
begin;
update public.geststock_sales s set stock_ignore = b.stock_ignore, hors_stock = b.hors_stock, site = b.site, updated_at = now() from geststock_backup.hors_stock_sales_backup b where s.id = b.id;
commit;
