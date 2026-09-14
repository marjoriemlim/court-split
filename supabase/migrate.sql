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
    (s.shuttle_count * s.shuttle_price_each) / nullif(ht.total_headcount, 0) as shuttle_unit_cost
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
-- 8. Tell PostgREST to pick up the new columns immediately
--    (this is what the "schema cache" error is about)
-- ---------------------------------------------------------------
notify pgrst, 'reload schema';
