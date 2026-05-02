-- GestStock ERP - schema Supabase
-- A executer dans Supabase > SQL Editor.

create table if not exists public.geststock_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.geststock_state (id, payload, updated_at)
values (
  'main',
  '{
    "version": "1.0",
    "updatedAt": "2026-05-02T00:00:00.000Z",
    "users": [
      {
        "id": "u-admin",
        "name": "admin",
        "role": "admin",
        "passwordHash": "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4"
      },
      {
        "id": "u-visiteur",
        "name": "visiteur",
        "role": "visitor",
        "passwordHash": "9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0"
      }
    ],
    "data": {
      "articles": [],
      "clients": [],
      "suppliers": [],
      "sites": [],
      "purchases": [],
      "sales": [],
      "transfers": [],
      "inventories": [],
      "clientPrices": [],
      "supplierPrices": [],
      "payments": [],
      "rolls": [],
      "rollCuts": []
    }
  }'::jsonb,
  now()
)
on conflict (id) do nothing;

alter table public.geststock_state enable row level security;

drop policy if exists "GestStock read state" on public.geststock_state;
drop policy if exists "GestStock write state" on public.geststock_state;

-- Frontend-only mode:
-- L'anon key peut lire/ecrire cette ligne. Ne stockez pas d'informations ultra sensibles ici.
-- Pour une securite maximale, il faudra ajouter Supabase Auth + policies par utilisateur.
create policy "GestStock read state"
on public.geststock_state
for select
to anon
using (true);

create policy "GestStock write state"
on public.geststock_state
for all
to anon
using (id = 'main')
with check (id = 'main');

alter publication supabase_realtime add table public.geststock_state;
