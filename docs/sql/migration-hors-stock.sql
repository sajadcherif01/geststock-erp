-- Migration hors stock - staging first, no destructive operation.
begin;
create schema if not exists geststock_backup;
create table if not exists geststock_backup.hors_stock_sales_backup as select now() as backup_created_at, * from public.geststock_sales;
create table if not exists geststock_backup.hors_stock_state_backup as select now() as backup_created_at, * from public.geststock_state;
update public.geststock_sales set stock_ignore = true, hors_stock = true, site = coalesce(site, ''), updated_at = now() where coalesce(is_buyback, false) = false;
commit;
