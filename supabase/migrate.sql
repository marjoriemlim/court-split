-- Court Split - bring an existing database up to the current schema.
-- Safe to run more than once; every step is guarded.
-- Paste the whole file into Supabase Studio > SQL Editor and Run.

-- ---------------------------------------------------------------
-- 0. Drop the summary view up front.
--    It reads sessions.shuttle_unit_cost and payment_groups.water_cost /
--    penalty, so Postgres refuses to drop those columns while it exists.
--    Step 5 rebuilds it against the new shape.
-- ---------------------------------------------------------------
drop view if exists session_summary;

-- ---------------------------------------------------------------
-- 1. Player groups (couples / families billed as one line)
-- ---------------------------------------------------------------
create table if not exists player_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table players
  add column if not exists group_id uuid references player_groups(id) on delete set null;

-- ---------------------------------------------------------------
-- 2. Session columns: derived shuttle cost, court-fee mode, label
-- ---------------------------------------------------------------
alter table sessions
  add column if not exists court_fee_mode      text not null default 'per_person',
  add column if not exists court_fee_total     numeric(10,2) not null default 0,
  add column if not exists shuttle_count       numeric(10,2) not null default 0,
  add column if not exists shuttle_price_each  numeric(10,2) not null default 0,
  add column if not exists shuttles            jsonb not null default '[]'::jsonb,
  add column if not exists label               text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_court_fee_mode_check') then
    alter table sessions add constraint sessions_court_fee_mode_check
      check (court_fee_mode in ('per_person', 'split'));
  end if;
end $$;

-- Old rows stored a per-person shuttle figure. Rebuild it as 1 shuttle priced
-- at (old per-head cost x that headcount) so past totals still hold.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'sessions' and column_name = 'shuttle_unit_cost') then
    execute $mig$
      update sessions s
         set shuttle_count = 1,
             shuttle_price_each = s.shuttle_unit_cost * coalesce(
               (select sum(pg.headcount) from payment_groups pg where pg.session_id = s.id), 0)
       where s.shuttle_price_each = 0
    $mig$;
    alter table sessions drop column shuttle_unit_cost;
  end if;
end $$;

-- Several sessions may share a date (morning + evening game).
alter table sessions drop constraint if exists sessions_session_date_key;

-- ---------------------------------------------------------------
-- 3. Extra costs replace the fixed water / penalty columns
-- ---------------------------------------------------------------
create table if not exists extra_costs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  label text not null,
  amount numeric(10,2) not null default 0,
  payment_group_id uuid references payment_groups(id) on delete cascade, -- null = split among everyone
  created_at timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'payment_groups' and column_name = 'water_cost') then
    insert into extra_costs (session_id, label, amount, payment_group_id)
      select session_id, 'Water', water_cost, id from payment_groups where water_cost > 0;
    alter table payment_groups drop column water_cost;
  end if;

  if exists (select 1 from information_schema.columns
             where table_name = 'payment_groups' and column_name = 'penalty') then
    insert into extra_costs (session_id, label, amount, payment_group_id)
      select session_id, 'Penalty', penalty, id from payment_groups where penalty > 0;
    alter table payment_groups drop column penalty;
  end if;
end $$;

-- ---------------------------------------------------------------
-- 4. Row Level Security for the new tables
-- ---------------------------------------------------------------
alter table player_groups enable row level security;
alter table extra_costs   enable row level security;

drop policy if exists "authenticated read player_groups"  on player_groups;
drop policy if exists "authenticated write player_groups" on player_groups;
create policy "authenticated read player_groups"  on player_groups for select using (auth.role() = 'authenticated');
create policy "authenticated write player_groups" on player_groups for all    using (auth.role() = 'authenticated');

drop policy if exists "authenticated read extras"  on extra_costs;
drop policy if exists "authenticated write extras" on extra_costs;
create policy "authenticated read extras"  on extra_costs for select using (auth.role() = 'authenticated');
create policy "authenticated write extras" on extra_costs for all    using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------
-- 5. Rebuild the summary view against the new shape (dropped in step 0)
-- ---------------------------------------------------------------
create view session_summary with (security_invoker = on) as
with head_totals as (
  select session_id, sum(headcount) as total_headcount
  from payment_groups
  group by session_id
),
rates as (
  select
    s.id as session_id,
    case
      when s.court_fee_mode = 'split'
        then s.court_fee_total / nullif(ht.total_headcount, 0)
      else s.court_fee_per_slot
    end as court_unit_cost,
    -- sum of every shuttle line; sessions without lines fall back to the
    -- single-shuttle columns
    coalesce(
      (select sum(coalesce((l->>'count')::numeric, 0) * coalesce((l->>'price_each')::numeric, 0))
         from jsonb_array_elements(s.shuttles) l),
      s.shuttle_count * s.shuttle_price_each
    ) / nullif(ht.total_headcount, 0) as shuttle_unit_cost
  from sessions s
  left join head_totals ht on ht.session_id = s.id
),
split_extras as (
  select session_id, sum(amount) as split_total
  from extra_costs
  where payment_group_id is null
  group by session_id
),
direct_extras as (
  select payment_group_id, sum(amount) as direct_total
  from extra_costs
  where payment_group_id is not null
  group by payment_group_id
)
select
  pg.id as group_id,
  s.id as session_id,
  s.session_date,
  s.label as session_label,
  p.name as payer_name,
  pg.payer_status_snapshot as status,
  pg.headcount,
  coalesce(r.court_unit_cost, 0) * pg.headcount as court_total,
  coalesce(r.shuttle_unit_cost, 0) * pg.headcount as shuttle_total,
  coalesce(de.direct_total, 0)
    + coalesce(se.split_total, 0) / nullif(ht.total_headcount, 0) * pg.headcount as extras_total,
  (coalesce(r.court_unit_cost, 0) + coalesce(r.shuttle_unit_cost, 0)) * pg.headcount
    + coalesce(de.direct_total, 0)
    + coalesce(se.split_total, 0) / nullif(ht.total_headcount, 0) * pg.headcount as actual_cost,
  case
    when pg.payer_status_snapshot = 'guest'
      then s.guest_fixed_rate * pg.headcount
           + coalesce(de.direct_total, 0)
           + coalesce(se.split_total, 0) / nullif(ht.total_headcount, 0) * pg.headcount
    else (coalesce(r.court_unit_cost, 0) + coalesce(r.shuttle_unit_cost, 0)) * pg.headcount
           + coalesce(de.direct_total, 0)
           + coalesce(se.split_total, 0) / nullif(ht.total_headcount, 0) * pg.headcount
  end as amount_to_pay,
  case
    when pg.payer_status_snapshot = 'guest'
      then (s.guest_fixed_rate * pg.headcount)
           - ((coalesce(r.court_unit_cost, 0) + coalesce(r.shuttle_unit_cost, 0)) * pg.headcount)
    else 0
  end as funds_generated
from payment_groups pg
join sessions s on s.id = pg.session_id
join players  p on p.id = pg.payer_id
left join head_totals   ht on ht.session_id = s.id
left join rates         r  on r.session_id  = s.id
left join split_extras  se on se.session_id = s.id
left join direct_extras de on de.payment_group_id = pg.id;

-- ---------------------------------------------------------------
-- 6. Fund settings: one row of figures that aren't derived from sessions.
--    `opening_balance` is money already in the kitty before the first
--    session this app tracks. Edit the values below to match your own
--    starting figure; re-running keeps whatever is already there.
-- ---------------------------------------------------------------
create table if not exists fund_settings (
  id boolean primary key default true check (id),  -- the check pins this to one row
  opening_balance numeric(12,2) not null default 0,
  opening_as_of date,
  updated_at timestamptz not null default now()
);

alter table fund_settings enable row level security;

drop policy if exists "authenticated read fund_settings" on fund_settings;
drop policy if exists "authenticated write fund_settings" on fund_settings;

create policy "authenticated read fund_settings" on fund_settings for select using (auth.role() = 'authenticated');
create policy "authenticated write fund_settings" on fund_settings for all using (auth.role() = 'authenticated');

insert into fund_settings (id, opening_balance, opening_as_of)
values (true, 1623.68, '2026-09-03')
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 7. Paid tracking: when each payer settled up (null = still owes)
-- ---------------------------------------------------------------
alter table payment_groups add column if not exists paid_at timestamptz;

-- ---------------------------------------------------------------
-- 8. Shuttle types: the brands/grades you buy, each with a suggested
--    base price. A session still stores its own shuttle_price_each, so
--    the actual price paid can vary session to session even for the same
--    type (bulk deals, price hikes, etc.).
-- ---------------------------------------------------------------
create table if not exists shuttle_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  base_price numeric(10,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table sessions
  add column if not exists shuttle_type_id uuid references shuttle_types(id) on delete set null;

alter table shuttle_types enable row level security;

drop policy if exists "authenticated read shuttle_types" on shuttle_types;
drop policy if exists "authenticated write shuttle_types" on shuttle_types;
create policy "authenticated read shuttle_types" on shuttle_types for select using (auth.role() = 'authenticated');
create policy "authenticated write shuttle_types" on shuttle_types for all using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------
-- 9. Several shuttle types per session: move each session's single
--    shuttle into a one-line `shuttles` list. Only touches sessions with
--    no lines yet, so re-running it is harmless.
-- ---------------------------------------------------------------
update sessions s
   set shuttles = jsonb_build_array(jsonb_build_object(
         'id', 'legacy',
         'type_id', s.shuttle_type_id,
         'name', (select st.name from shuttle_types st where st.id = s.shuttle_type_id),
         'count', s.shuttle_count,
         'price_each', s.shuttle_price_each))
 where s.shuttles = '[]'::jsonb
   and (s.shuttle_count <> 0 or s.shuttle_price_each <> 0);

-- ---------------------------------------------------------------
-- 10. Queue master: courts, skill ranks, the night's queue, matches
-- ---------------------------------------------------------------

-- Skill rank on the permanent roster: newbie < beginner < intermediate < advanced.
alter table players
  add column if not exists rank text not null default 'beginner';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'players_rank_check') then
    alter table players add constraint players_rank_check
      check (rank in ('newbie', 'beginner', 'intermediate', 'advanced'));
  end if;
end $$;

-- How many courts the session has booked.
alter table sessions
  add column if not exists court_count int not null default 2;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_court_count_check') then
    alter table sessions add constraint sessions_court_count_check
      check (court_count between 1 and 20);
  end if;
end $$;

-- QUEUE ENTRIES: who is checked in to play this session. player_id links to
-- the roster when there is one; quick-added friends just have a name.
-- `rank` is a per-night copy of the player's rank, so it can be overridden.
-- "Playing" isn't stored: it's whoever is in an in-progress match.
--   waiting -> in the queue, ordered by available_since (oldest first)
--   resting -> sitting out; back in the queue once resting_until passes
--              (null resting_until = until the queue master brings them back)
--   left    -> gone for the night, stats kept
create table if not exists queue_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  player_id uuid references players(id) on delete set null,
  display_name text not null,
  rank text not null default 'beginner'
    check (rank in ('newbie', 'beginner', 'intermediate', 'advanced')),
  state text not null default 'waiting'
    check (state in ('waiting', 'resting', 'left')),
  available_since timestamptz not null default now(),
  resting_until timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists queue_entries_session_idx on queue_entries (session_id);
create index if not exists queue_entries_player_idx on queue_entries (player_id);
-- A roster player can only be checked in once per session.
create unique index if not exists queue_entries_session_player_key
  on queue_entries (session_id, player_id) where player_id is not null;

-- MATCHES: one game on one court. Scores stay null until the game ends.
create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  court_no int not null check (court_no > 0),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'done', 'void')),
  team_a_score int check (team_a_score between 0 and 99),
  team_b_score int check (team_b_score between 0 and 99),
  winner text check (winner in ('a', 'b')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists matches_session_idx on matches (session_id);

-- MATCH PLAYERS: who was on which side of each match.
create table if not exists match_players (
  match_id uuid not null references matches(id) on delete cascade,
  entry_id uuid not null references queue_entries(id) on delete restrict,
  team text not null check (team in ('a', 'b')),
  primary key (match_id, entry_id)
);

create index if not exists match_players_entry_idx on match_players (entry_id);

alter table queue_entries enable row level security;
alter table matches       enable row level security;
alter table match_players enable row level security;

drop policy if exists "authenticated read queue_entries"  on queue_entries;
drop policy if exists "authenticated write queue_entries" on queue_entries;
create policy "authenticated read queue_entries"  on queue_entries for select using (auth.role() = 'authenticated');
create policy "authenticated write queue_entries" on queue_entries for all    using (auth.role() = 'authenticated');

drop policy if exists "authenticated read matches"  on matches;
drop policy if exists "authenticated write matches" on matches;
create policy "authenticated read matches"  on matches for select using (auth.role() = 'authenticated');
create policy "authenticated write matches" on matches for all    using (auth.role() = 'authenticated');

drop policy if exists "authenticated read match_players"  on match_players;
drop policy if exists "authenticated write match_players" on match_players;
create policy "authenticated read match_players"  on match_players for select using (auth.role() = 'authenticated');
create policy "authenticated write match_players" on match_players for all    using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------
-- 11. Tell PostgREST to pick up the new columns immediately
--    (this is what the "schema cache" error is about)
-- ---------------------------------------------------------------
notify pgrst, 'reload schema';
