-- Backup checklist before hors-stock migration.
create schema if not exists geststock_backup;
create table if not exists geststock_backup.full_backup_manifest (id text primary key, created_at timestamptz not null default now(), note text not null);
insert into geststock_backup.full_backup_manifest (id, note) values ('hors-stock-preflight', 'Manual preflight marker before hors-stock migration') on conflict (id) do update set created_at = now(), note = excluded.note;
-- Also export all public.geststock_* tables and project configuration before production.
