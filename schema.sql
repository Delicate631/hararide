-- Run this whole file in Supabase > SQL Editor
create table profiles(id uuid primary key references auth.users on delete cascade, name text, phone text,
  role text check(role in('passenger','driver','admin')) default 'passenger');
create table rides(id bigint generated always as identity primary key,
  passenger_id uuid references profiles, driver_id uuid references profiles,
  pickup_name text, pickup_lat float8, pickup_lng float8, drop_name text, drop_lat float8, drop_lng float8,
  km numeric, price numeric, payment text default 'cash', paid boolean default false,
  status text default 'requested', commission numeric default 0, created_at timestamptz default now());
create table driver_locations(driver_id uuid primary key references profiles, lat float8, lng float8, updated_at timestamptz default now());

create function is_admin() returns boolean language sql security definer as
$$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;

-- 10% commission is calculated by the database, so it cannot be tampered with from the browser
create function set_commission() returns trigger language plpgsql as
$$ begin if new.status='done' then new.commission := round(new.price*0.10,2); end if; return new; end $$;
create trigger rides_commission before update on rides for each row execute function set_commission();

alter table profiles enable row level security;
alter table rides enable row level security;
alter table driver_locations enable row level security;

create policy "read profiles" on profiles for select to authenticated using(true);
create policy "create own profile" on profiles for insert to authenticated
  with check(id=auth.uid() and role in('passenger','driver'));

create policy "ride insert" on rides for insert to authenticated with check(passenger_id=auth.uid());
create policy "ride select" on rides for select to authenticated
  using(passenger_id=auth.uid() or driver_id=auth.uid() or status='requested' or is_admin());
create policy "ride update" on rides for update to authenticated
  using(passenger_id=auth.uid() or driver_id=auth.uid() or (status='requested' and driver_id is null) or is_admin());

create policy "loc read" on driver_locations for select to authenticated using(true);
create policy "loc write" on driver_locations for all to authenticated
  using(driver_id=auth.uid()) with check(driver_id=auth.uid());

alter publication supabase_realtime add table rides;

-- After you sign up with your own account, make yourself the super user:
-- update profiles set role='admin' where id=(select id from auth.users where email='YOUR@EMAIL.COM');
