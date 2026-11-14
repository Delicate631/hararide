-- Hararide safety update. Run once in Supabase > SQL Editor (new query), after schema.sql and schema_update.sql

-- 1. Driver approval. Existing accounts stay approved; NEW drivers start as pending.
alter table profiles add column approved boolean default false;
update profiles set approved = true;
create function set_approved() returns trigger language plpgsql as
$$ begin new.approved := (new.role = 'passenger'); return new; end $$;
create trigger profiles_approved before insert on profiles for each row execute function set_approved();
create function is_approved_driver() returns boolean language sql security definer as
$$ select exists(select 1 from profiles where id = auth.uid() and role = 'driver' and approved) $$;
create policy "admin update profiles" on profiles for update to authenticated using (is_admin());

-- 2. Privacy: you only see your own profile, or the person on the other end of your ride
drop policy "read profiles" on profiles;
create policy "read profiles" on profiles for select to authenticated using (
  id = auth.uid() or is_admin() or exists (select 1 from rides r where
    (r.passenger_id = profiles.id and r.driver_id = auth.uid()) or (r.driver_id = profiles.id and r.passenger_id = auth.uid())));

-- 3. Only approved drivers can see open requests, accept rides and share location
drop policy "ride select" on rides;
create policy "ride select" on rides for select to authenticated using (
  passenger_id = auth.uid() or driver_id = auth.uid() or is_admin() or (status = 'requested' and is_approved_driver()));
drop policy "ride update" on rides;
create policy "ride update" on rides for update to authenticated using (
  passenger_id = auth.uid() or driver_id = auth.uid() or is_admin() or (status = 'requested' and driver_id is null and is_approved_driver()));
drop policy "loc write" on driver_locations;
create policy "loc write" on driver_locations for all to authenticated
  using (driver_id = auth.uid()) with check (driver_id = auth.uid() and is_approved_driver());

-- 4. Anti-tampering: the database enforces who may change what on a ride
create function guard_ride() returns trigger language plpgsql as $$
declare me uuid := auth.uid();
begin
  if me is null or is_admin() then return new; end if;
  if new.price is distinct from old.price or new.passenger_id is distinct from old.passenger_id or new.km is distinct from old.km
     or new.payment is distinct from old.payment or new.commission is distinct from old.commission or new.paid is distinct from old.paid then
    raise exception 'Not allowed'; end if;
  if old.driver_id is null and old.status = 'requested' and me <> old.passenger_id then      -- a driver accepting
    if not is_approved_driver() then raise exception 'Driver not approved'; end if;
    if new.driver_id is distinct from me or new.status <> 'accepted' or new.rating is distinct from old.rating then raise exception 'Not allowed'; end if;
    return new; end if;
  if me = old.passenger_id then                                                              -- the passenger
    if new.driver_id is distinct from old.driver_id then raise exception 'Not allowed'; end if;
    if new.status is distinct from old.status and not (old.status = 'requested' and new.status = 'cancelled') then raise exception 'Not allowed'; end if;
    if new.rating is distinct from old.rating and (old.status <> 'done' or old.rating is not null or new.rating is null) then raise exception 'Not allowed'; end if;
    return new; end if;
  if me = old.driver_id then                                                                 -- the driver
    if new.driver_id is distinct from old.driver_id or new.rating is distinct from old.rating then raise exception 'Not allowed'; end if;
    if new.status is distinct from old.status and not ((old.status = 'accepted' and new.status = 'progress') or (old.status = 'progress' and new.status = 'done')) then raise exception 'Not allowed'; end if;
    return new; end if;
  raise exception 'Not allowed';
end $$;
create trigger rides_a_guard before update on rides for each row execute function guard_ride();
