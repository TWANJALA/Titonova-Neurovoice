-- Supabase schema for AI publishing system
-- Run in the SQL editor or psql against your Supabase project.

-- Core memory tables
create table if not exists public.narrative_memory (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.book_memory (
  book_id uuid primary key references public.books (id) on delete cascade,
  memory_json jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Characters tracker
create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id uuid references public.books (id) on delete cascade,
  name text not null,
  role text,
  summary text,
  traits jsonb,
  status text,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists characters_user_id_idx on public.characters (user_id);
create index if not exists characters_book_id_idx on public.characters (book_id);

-- Optional: memory snapshots for dashboard history
create table if not exists public.memory_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id uuid references public.books (id) on delete cascade,
  snapshot jsonb not null,
  inserted_at timestamptz not null default now()
);
create index if not exists memory_snapshots_user_id_idx on public.memory_snapshots (user_id);
create index if not exists memory_snapshots_book_id_idx on public.memory_snapshots (book_id);

-- Bucket for exports already assumed: "exports"
-- Grant storage policies in Supabase UI or SQL as needed.
