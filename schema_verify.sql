-- Hararide driver verification. Run once in Supabase > SQL Editor (new query), after schema_safety.sql

-- Private storage for ID photos (nobody can open them without a login; only the driver and admins can)
insert into storage.buckets(id, name, public) values ('driver-docs', 'driver-docs', false) on conflict do nothing;
create policy "driver uploads own docs" on storage.objects for insert to authenticated
  with check (bucket_id = 'driver-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "read own or admin docs" on storage.objects for select to authenticated
  using (bucket_id = 'driver-docs' and ((storage.foldername(name))[1] = auth.uid()::text or is_admin()));

-- Car details passengers may see (plate and car); the ID number stays private in driver_docs
alter table profiles add column plate text, add column car text;
create table driver_docs(driver_id uuid primary key references profiles, id_number text not null, plate text not null, car_model text not null,
  id_path text, licence_path text, selfie_path text, car_path text, submitted_at timestamptz default now());
create unique index on driver_docs (upper(id_number));   -- one person, one account
create unique index on driver_docs (upper(plate));       -- one car, one driver
alter table driver_docs enable row level security;
create policy "own or admin read docs" on driver_docs for select to authenticated using (driver_id = auth.uid() or is_admin());

create function submit_driver_docs(p_id_number text, p_plate text, p_car text, p_id_path text, p_licence_path text, p_selfie_path text, p_car_path text)
returns void language plpgsql security definer as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and role = 'driver' and not approved) then raise exception 'Only pending drivers can submit documents'; end if;
  insert into driver_docs(driver_id, id_number, plate, car_model, id_path, licence_path, selfie_path, car_path)
  values (auth.uid(), trim(p_id_number), upper(trim(p_plate)), trim(p_car), p_id_path, p_licence_path, p_selfie_path, p_car_path)
  on conflict (driver_id) do update set id_number = excluded.id_number, plate = excluded.plate, car_model = excluded.car_model,
    id_path = excluded.id_path, licence_path = excluded.licence_path, selfie_path = excluded.selfie_path, car_path = excluded.car_path, submitted_at = now();
  update profiles set plate = upper(trim(p_plate)), car = trim(p_car) where id = auth.uid();
end $$;

-- A driver cannot be approved until documents are uploaded
create function require_docs() returns trigger language plpgsql as $$
begin
  if new.role = 'driver' and new.approved and not coalesce(old.approved, false) and not exists (select 1 from driver_docs where driver_id = new.id)
  then raise exception 'This driver has not uploaded documents yet'; end if;
  return new;
end $$;
create trigger profiles_require_docs before update on profiles for each row execute function require_docs();

-- OPTIONAL: make drivers you already approved verify too (they will see the upload form). Remove the two dashes to use:
-- update profiles set approved = false where role = 'driver';
