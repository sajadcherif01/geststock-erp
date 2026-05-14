-- GestStock ERP - Migration vers tables par entite
-- Execute dans Supabase > SQL Editor.
-- Cree des tables individuelles pour chaque entite avec detection de conflit par ligne (updated_at).
-- Migre les donnees existantes depuis le bloc JSON geststock_state.

-- ===== FONCTION TRIGGER updated_at =====
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ===== CREATION DES TABLES =====

create table if not exists public.geststock_users (
  id text primary key,
  name text not null,
  role text not null default 'visitor',
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_articles (
  id text primary key,
  name text not null,
  type text not null default 'tapis',
  default_pm2 numeric default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_clients (
  id text primary key,
  name text not null,
  city text not null,
  initial numeric default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_suppliers (
  id text primary key,
  name text not null,
  city text not null,
  initial numeric default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_sites (
  id text primary key,
  name text not null,
  city text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_purchases (
  id text primary key,
  supplier text default '',
  article text default '',
  site text default '',
  color text default '',
  length numeric default 0,
  width numeric default 0,
  qty numeric default 0,
  pm2 numeric default 0,
  date text default '',
  note text default '',
  key text default '',
  total numeric default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_sales (
  id text primary key,
  client text default '',
  article text default '',
  site text default '',
  color text default '',
  length numeric default 0,
  width numeric default 0,
  qty numeric default 0,
  pm2 numeric default 0,
  date text default '',
  note text default '',
  key text default '',
  total numeric default 0,
  stock_ignore boolean default false,
  hors_stock boolean default false,
  is_fee boolean default false,
  fee_type text default '',
  moquette_sale boolean default false,
  roll_id text default '',
  roll_code text default '',
  source_length numeric default 0,
  remaining_length numeric default 0,
  source_key text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_transfers (
  id text primary key,
  article text default '',
  from_site text default '',
  to_site text default '',
  color text default '',
  length numeric default 0,
  width numeric default 0,
  qty numeric default 0,
  date text default '',
  note text default '',
  key text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_inventories (
  id text primary key,
  source_sale_id text default '',
  article text default '',
  site text default '',
  color text default '',
  length numeric default 0,
  width numeric default 0,
  adjust numeric default 0,
  date text default '',
  note text default '',
  key text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_client_prices (
  id text primary key,
  client text default '',
  article text default '',
  pm2 numeric default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_supplier_prices (
  id text primary key,
  supplier text default '',
  article text default '',
  pm2 numeric default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_payments (
  id text primary key,
  type text default '',
  name text default '',
  date text default '',
  amount numeric default 0,
  mode text default '',
  due text default '',
  note text default '',
  deduct_now boolean default true,
  paid_status text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_rolls (
  id text primary key,
  code text default '',
  article text default '',
  color text default '',
  width numeric default 0,
  original_length numeric default 0,
  current_length numeric default 0,
  site text default '',
  purchase_date text default '',
  purchase_ref text default '',
  status text default 'full',
  note text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.geststock_roll_cuts (
  id text primary key,
  source_sale_id text default '',
  roll_id text default '',
  roll_code text default '',
  article text default '',
  color text default '',
  width numeric default 0,
  site text default '',
  client text default '',
  date text default '',
  sold_length numeric default 0,
  previous_length numeric default 0,
  remaining_length numeric default 0,
  pm2 numeric default 0,
  total numeric default 0,
  note text default '',
  updated_at timestamptz not null default now()
);

-- ===== CREATION DES TRIGGERS (supprime l'ancien s'il existe) =====
do $$
declare
  tbl text;
  tables text[] := array[
    'geststock_users','geststock_articles','geststock_clients','geststock_suppliers',
    'geststock_sites','geststock_purchases','geststock_sales','geststock_transfers',
    'geststock_inventories','geststock_client_prices','geststock_supplier_prices',
    'geststock_payments','geststock_rolls','geststock_roll_cuts'
  ];
begin
  foreach tbl in array tables loop
    begin
      execute format('drop trigger if exists trg_%I_updated_at on %I', tbl, tbl);
      execute format('create trigger trg_%I_updated_at before insert or update on %I
        for each row execute function public.set_updated_at()', tbl, tbl);
    exception when undefined_table then
      raise notice 'Table % n''existe pas, trigger ignore', tbl;
    end;
  end loop;
end $$;

-- ===== MIGRATION DES DONNEES EXISTANTES =====
-- Extrait les tableaux du blob JSON geststock_state et les insere dans les nouvelles tables.
do $$
declare
  blob jsonb;
  row_record record;
begin
  select payload into blob from public.geststock_state where id = 'main';
  if blob is null then
    raise notice 'Aucune donnee existante dans geststock_state. Migration ignoree.';
    return;
  end if;

  -- Users
  if blob->'users' is not null and jsonb_array_length(blob->'users') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'users') as x(id text, name text, role text, "passwordHash" text) loop
      insert into public.geststock_users (id, name, role, password_hash, updated_at)
      values (row_record.id, row_record.name, row_record.role, row_record."passwordHash", now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Articles
  if blob->'data'->'articles' is not null and jsonb_array_length(blob->'data'->'articles') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'articles') as x(id text, name text, type text, "defaultPm2" numeric) loop
      insert into public.geststock_articles (id, name, type, default_pm2, updated_at)
      values (row_record.id, row_record.name, coalesce(row_record.type, 'tapis'), row_record."defaultPm2", now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Clients
  if blob->'data'->'clients' is not null and jsonb_array_length(blob->'data'->'clients') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'clients') as x(id text, name text, city text, initial numeric) loop
      insert into public.geststock_clients (id, name, city, initial, updated_at)
      values (row_record.id, row_record.name, row_record.city, row_record.initial, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Suppliers
  if blob->'data'->'suppliers' is not null and jsonb_array_length(blob->'data'->'suppliers') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'suppliers') as x(id text, name text, city text, initial numeric) loop
      insert into public.geststock_suppliers (id, name, city, initial, updated_at)
      values (row_record.id, row_record.name, row_record.city, row_record.initial, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Sites
  if blob->'data'->'sites' is not null and jsonb_array_length(blob->'data'->'sites') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'sites') as x(id text, name text, city text) loop
      insert into public.geststock_sites (id, name, city, updated_at)
      values (row_record.id, row_record.name, row_record.city, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Purchases
  if blob->'data'->'purchases' is not null and jsonb_array_length(blob->'data'->'purchases') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'purchases') as x(id text, supplier text, article text, site text, color text, length numeric, width numeric, qty numeric, pm2 numeric, date text, note text, key text, total numeric) loop
      insert into public.geststock_purchases (id, supplier, article, site, color, length, width, qty, pm2, date, note, key, total, updated_at)
      values (row_record.id, row_record.supplier, row_record.article, row_record.site, row_record.color, row_record.length, row_record.width, row_record.qty, row_record.pm2, row_record.date, row_record.note, row_record.key, row_record.total, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Sales
  if blob->'data'->'sales' is not null and jsonb_array_length(blob->'data'->'sales') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'sales') as x(
      id text, client text, article text, site text, color text, length numeric, width numeric, qty numeric, pm2 numeric,
      date text, note text, key text, total numeric, "stockIgnore" boolean, "horsStock" boolean, "isFee" boolean,
      "feeType" text, "moquetteSale" boolean, "rollId" text, "rollCode" text, "sourceLength" numeric,
      "remainingLength" numeric, "sourceKey" text
    ) loop
      insert into public.geststock_sales (
        id, client, article, site, color, length, width, qty, pm2, date, note, key, total,
        stock_ignore, hors_stock, is_fee, fee_type, moquette_sale, roll_id, roll_code,
        source_length, remaining_length, source_key, updated_at
      ) values (
        row_record.id, row_record.client, row_record.article, row_record.site, row_record.color,
        row_record.length, row_record.width, row_record.qty, row_record.pm2, row_record.date,
        row_record.note, row_record.key, row_record.total,
        coalesce(row_record."stockIgnore", false), coalesce(row_record."horsStock", false),
        coalesce(row_record."isFee", false), row_record."feeType", coalesce(row_record."moquetteSale", false),
        row_record."rollId", row_record."rollCode", row_record."sourceLength", row_record."remainingLength",
        row_record."sourceKey", now()
      ) on conflict (id) do nothing;
    end loop;
  end if;

  -- Transfers
  if blob->'data'->'transfers' is not null and jsonb_array_length(blob->'data'->'transfers') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'transfers') as x(id text, article text, "from" text, "to" text, color text, length numeric, width numeric, qty numeric, date text, note text, key text) loop
      insert into public.geststock_transfers (id, article, from_site, to_site, color, length, width, qty, date, note, key, updated_at)
      values (row_record.id, row_record.article, row_record."from", row_record."to", row_record.color, row_record.length, row_record.width, row_record.qty, row_record.date, row_record.note, row_record.key, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Inventories
  if blob->'data'->'inventories' is not null and jsonb_array_length(blob->'data'->'inventories') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'inventories') as x(id text, "sourceSaleId" text, article text, site text, color text, length numeric, width numeric, adjust numeric, date text, note text, key text) loop
      insert into public.geststock_inventories (id, source_sale_id, article, site, color, length, width, adjust, date, note, key, updated_at)
      values (row_record.id, row_record."sourceSaleId", row_record.article, row_record.site, row_record.color, row_record.length, row_record.width, row_record.adjust, row_record.date, row_record.note, row_record.key, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Client prices
  if blob->'data'->'clientPrices' is not null and jsonb_array_length(blob->'data'->'clientPrices') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'clientPrices') as x(id text, client text, article text, pm2 numeric) loop
      insert into public.geststock_client_prices (id, client, article, pm2, updated_at)
      values (row_record.id, row_record.client, row_record.article, row_record.pm2, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Supplier prices
  if blob->'data'->'supplierPrices' is not null and jsonb_array_length(blob->'data'->'supplierPrices') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'supplierPrices') as x(id text, supplier text, article text, pm2 numeric) loop
      insert into public.geststock_supplier_prices (id, supplier, article, pm2, updated_at)
      values (row_record.id, row_record.supplier, row_record.article, row_record.pm2, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Payments
  if blob->'data'->'payments' is not null and jsonb_array_length(blob->'data'->'payments') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'payments') as x(id text, type text, name text, date text, amount numeric, mode text, due text, note text, "deductNow" boolean, "paidStatus" text) loop
      insert into public.geststock_payments (id, type, name, date, amount, mode, due, note, deduct_now, paid_status, updated_at)
      values (row_record.id, row_record.type, row_record.name, row_record.date, row_record.amount, row_record.mode, row_record.due, row_record.note, coalesce(row_record."deductNow", true), row_record."paidStatus", now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Rolls
  if blob->'data'->'rolls' is not null and jsonb_array_length(blob->'data'->'rolls') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'rolls') as x(id text, code text, article text, color text, width numeric, "originalLength" numeric, "currentLength" numeric, site text, "purchaseDate" text, "purchaseRef" text, status text, note text) loop
      insert into public.geststock_rolls (id, code, article, color, width, original_length, current_length, site, purchase_date, purchase_ref, status, note, updated_at)
      values (row_record.id, row_record.code, row_record.article, row_record.color, row_record.width, row_record."originalLength", row_record."currentLength", row_record.site, row_record."purchaseDate", row_record."purchaseRef", coalesce(row_record.status, 'full'), row_record.note, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  -- Roll cuts
  if blob->'data'->'rollCuts' is not null and jsonb_array_length(blob->'data'->'rollCuts') > 0 then
    for row_record in select * from jsonb_to_recordset(blob->'data'->'rollCuts') as x(id text, "sourceSaleId" text, "rollId" text, "rollCode" text, article text, color text, width numeric, site text, client text, date text, "soldLength" numeric, "previousLength" numeric, "remainingLength" numeric, pm2 numeric, total numeric, note text) loop
      insert into public.geststock_roll_cuts (id, source_sale_id, roll_id, roll_code, article, color, width, site, client, date, sold_length, previous_length, remaining_length, pm2, total, note, updated_at)
      values (row_record.id, row_record."sourceSaleId", row_record."rollId", row_record."rollCode", row_record.article, row_record.color, row_record.width, row_record.site, row_record.client, row_record.date, row_record."soldLength", row_record."previousLength", row_record."remainingLength", row_record.pm2, row_record.total, row_record.note, now())
      on conflict (id) do nothing;
    end loop;
  end if;

  raise notice 'Migration des donnees existantes terminee avec succes.';
end $$;

-- ===== POLITIQUES RLS =====
do $$
declare
  tbl text;
  tables text[] := array[
    'geststock_users','geststock_articles','geststock_clients','geststock_suppliers',
    'geststock_sites','geststock_purchases','geststock_sales','geststock_transfers',
    'geststock_inventories','geststock_client_prices','geststock_supplier_prices',
    'geststock_payments','geststock_rolls','geststock_roll_cuts'
  ];
begin
  foreach tbl in array tables loop
    begin
      execute format('alter table %I enable row level security', tbl);
      execute format('drop policy if exists "GestStock read %s" on %I', tbl, tbl);
      execute format('drop policy if exists "GestStock write %s" on %I', tbl, tbl);
      execute format('create policy "GestStock read %s" on %I for select to anon using (true)', tbl, tbl);
      execute format('create policy "GestStock write %s" on %I for all to anon using (true) with check (true)', tbl, tbl);
    exception when undefined_table then
      raise notice 'Table % n''existe pas, RLS ignore', tbl;
    end;
  end loop;
end $$;

-- ===== REPLICATION TEMPS REEL =====
do $$
declare
  tbl text;
  tables text[] := array[
    'geststock_users','geststock_articles','geststock_clients','geststock_suppliers',
    'geststock_sites','geststock_purchases','geststock_sales','geststock_transfers',
    'geststock_inventories','geststock_client_prices','geststock_supplier_prices',
    'geststock_payments','geststock_rolls','geststock_roll_cuts'
  ];
begin
  foreach tbl in array tables loop
    begin
      execute format('alter publication supabase_realtime add table %I', tbl);
    exception when undefined_table then
      raise notice 'Table % n''existe pas, publication ignore', tbl;
    when unique_violation then
      raise notice 'Table % deja dans la publication', tbl;
    end;
  end loop;
end $$;

-- Note: la table geststock_history est conservee telle quelle pour la compatibilite ascendante.
-- Les nouvelles ecritures utiliseront les tables individuelles.
