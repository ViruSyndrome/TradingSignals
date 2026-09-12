-- TrendRunner durable portfolio sync (run once in Supabase SQL Editor)
-- Prefer this table over auth user_metadata (size limits / race-prone).

create table if not exists public.user_portfolios (
  user_id uuid primary key references auth.users (id) on delete cascade,
  invested jsonb not null default '[]'::jsonb,
  watchlist jsonb not null default '[]'::jsonb,
  holdings_meta jsonb not null default '{}'::jsonb,
  followed jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_portfolios enable row level security;

drop policy if exists "Users manage own portfolio" on public.user_portfolios;
create policy "Users manage own portfolio"
  on public.user_portfolios
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Optional: keep updated_at fresh
create or replace function public.touch_user_portfolios_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_portfolios_touch on public.user_portfolios;
create trigger user_portfolios_touch
  before update on public.user_portfolios
  for each row execute function public.touch_user_portfolios_updated_at();
