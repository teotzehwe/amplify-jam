-- Amplify registered accounts (host-managed username + scrypt password).
-- Run once in the Supabase SQL editor for the project you point at Amplify.
-- Night state (songs, roster, lineup) stays in Redis / jam.json; this table
-- is only for sign-in accounts so they survive a Redis wipe.

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

-- No anon/authenticated policies on purpose: only the service-role key
-- (used by the Amplify server) can read or write password hashes.
