-- Taqseem — Supabase schema (Auth + Postgres)
-- Run this once in the Supabase SQL Editor for a new project.

create extension if not exists pgcrypto;

-- ---------- profiles ----------
-- one row per employee, auto-populated when the admin creates the auth user
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  -- true until the employee sets their own password, replacing the
  -- admin-set temporary one; forced right after their first login.
  must_reset_password boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are viewable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

-- an employee picks their own display name once, from a fixed dropdown in
-- the app, the first time they log in with no name set yet (this is more
-- reliable than depending on the admin filling in user metadata correctly
-- at account-creation time). No insert/delete policy is needed: rows are
-- only ever created by the trigger below (security definer) or the admin
-- via the Dashboard / service_role, both of which bypass RLS.
create policy "users can set their own display name"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- left blank (not the email) when no metadata is set, so the app's
  -- "choose your name" gate reliably knows a name is still needed.
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- records ----------
-- one row per file (draft or completed); replaces the old single localStorage blob.
-- one row per save = one person's save can never touch another person's record.
create table public.records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  owner_name text not null default '',
  status text not null default 'draft' check (status in ('draft','completed')),
  title text not null default '',
  raw_text text not null default '',
  marks jsonb not null default '[]'::jsonb,
  next_id integer not null default 1,
  top_level integer,
  counts jsonb,
  exported_at timestamptz,
  export_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index records_owner_id_idx on public.records(owner_id);
create index records_status_idx on public.records(status);
create index records_updated_at_idx on public.records(updated_at desc);

create function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger records_set_updated_at
  before update on public.records
  for each row execute procedure public.set_updated_at();

alter table public.records enable row level security;

create policy "records are viewable by authenticated users"
  on public.records for select
  to authenticated
  using (true);

create policy "owners can insert their own records"
  on public.records for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy "owners can update their own records"
  on public.records for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "owners can delete their own records"
  on public.records for delete
  to authenticated
  using (owner_id = auth.uid());

-- ---------- uqn_extractions ----------
-- one row per "تشريعات أم القرى" extraction: the table an employee pulled for
-- a single gazette issue, kept so the log survives a page reload and is
-- visible to the whole team. `items` holds the rendered rows as-is
-- (title / decisionNo / authority / hasText / link), which keeps a historical
-- extraction stable even if uqn.gov.sa later edits the article.
create table public.uqn_extractions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  owner_name text not null default '',
  issue_number text not null default '',
  hijri_label text not null default '',      -- e.g. "17 صفر 1448هـ"
  gregorian_date date,
  source_url text not null default '',
  item_count integer not null default 0,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index uqn_extractions_created_at_idx on public.uqn_extractions(created_at desc);
create index uqn_extractions_owner_id_idx on public.uqn_extractions(owner_id);

alter table public.uqn_extractions enable row level security;

create policy "extractions are viewable by authenticated users"
  on public.uqn_extractions for select
  to authenticated
  using (true);

create policy "owners can insert their own extractions"
  on public.uqn_extractions for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy "owners can delete their own extractions"
  on public.uqn_extractions for delete
  to authenticated
  using (owner_id = auth.uid());

-- ---------- site_updates ----------
-- one row per "تحديثات المواقع" search: the date range an employee already
-- swept on one source site, plus what that sweep found. The rows are what
-- makes the range rule work — a new search whose range touches a range
-- already recorded for the same site is refused, so no two employees cover
-- the same days twice. `items` keeps the result as rendered, so a historical
-- search stays readable even after the source site edits the page.
create extension if not exists btree_gist;

create table public.site_updates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  owner_name text not null default '',
  site_key text not null,                    -- e.g. 'momah-regulations'
  site_name text not null default '',
  range_from date not null,
  range_to date not null,
  source_url text not null default '',
  scanned_count integer not null default 0,  -- entries examined on the site
  item_count integer not null default 0,     -- of those, entries in range
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint site_updates_range_order check (range_from <= range_to),
  -- the app refuses an overlapping range before it starts scanning; this is
  -- what still holds the rule when two employees search at the same moment.
  -- Deleting a search from the log frees its range again, as it should.
  constraint site_updates_no_overlap exclude using gist (
    site_key with =,
    daterange(range_from, range_to, '[]') with &&
  )
);

create index site_updates_created_at_idx on public.site_updates(created_at desc);
create index site_updates_owner_id_idx on public.site_updates(owner_id);

alter table public.site_updates enable row level security;

create policy "site updates are viewable by authenticated users"
  on public.site_updates for select
  to authenticated
  using (true);

create policy "owners can insert their own site updates"
  on public.site_updates for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy "owners can delete their own site updates"
  on public.site_updates for delete
  to authenticated
  using (owner_id = auth.uid());
