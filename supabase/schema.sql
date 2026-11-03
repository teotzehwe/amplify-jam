-- Amplify accounts + jam sessions.
-- Run in the Supabase SQL editor for the project Amplify points at.
--
-- amplify_accounts.jam_id is the *org* namespace (SUPABASE_JAM_ID / KV_PREFIX),
-- not a single night. Admins live here first; they then create jam sessions.
-- Night state (songs, roster, lineup) stays in Redis / files per jam id.

create table if not exists public.amplify_accounts (
  id text primary key,
  jam_id text not null default 'amplify',
  username text not null,
  display_name text not null,
  password_hash text not null,
  password_salt text not null,
  instruments jsonb not null default '[]'::jsonb,
  role text not null default 'player' check (role in ('admin', 'player')),
  disabled boolean not null default false,
  created_at bigint not null,
  unique (jam_id, username)
);

create index if not exists amplify_accounts_jam_id_idx
  on public.amplify_accounts (jam_id);

alter table public.amplify_accounts enable row level security;

-- Jam sessions an admin can open. Each id maps to its own Redis/file night blob.
create table if not exists public.amplify_jams (
  id text primary key,
  org_id text not null default 'amplify',
  name text not null,
  created_by text,
  created_at bigint not null,
  archived boolean not null default false
);

create index if not exists amplify_jams_org_id_idx
  on public.amplify_jams (org_id);

alter table public.amplify_jams enable row level security;

-- No anon/authenticated policies on purpose: only the service-role key
-- (used by the Amplify server) can read or write password hashes / jam rows.
