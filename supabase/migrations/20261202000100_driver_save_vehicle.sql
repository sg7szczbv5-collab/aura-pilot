-- ============================================================================
-- AURA · 017 · Captain resubmission: correct a rejected vehicle or add another
-- ----------------------------------------------------------------------------
-- public.driver_save_vehicle(p_vehicle_id, …) — called by a captain whose
-- application is not (yet) approved:
--   p_vehicle_id = id of their own vehicle in 'rejected' / 'pending_review'
--       → corrects it in place (same plate / sequence number allowed), status
--         back to 'pending_review', previous rejection reason and Wasl result cleared;
--   p_vehicle_id = null → registers another vehicle.
-- Either way the vehicle becomes the captain's current vehicle. Documents of the
-- vehicle are (re)uploaded with the normal driver_documents insert, and a rejected
-- application is resubmitted with submit_driver_application().
-- ============================================================================

create or replace function public.driver_save_vehicle(
  p_vehicle_id uuid,
  p_vehicle_class public.vehicle_class,
  p_make text, p_model text, p_year integer, p_color text,
  p_plate_letters text, p_plate_number text, p_sequence_number text, p_seats integer)
returns public.vehicles
language plpgsql security definer
set search_path = ''
as $$
declare
  d public.drivers;
  v public.vehicles;
begin
  select * into d from public.drivers where id = (select auth.uid()) for update;
  if not found then
    raise exception 'AURA: start a captain application first' using errcode = 'P0002';
  end if;
  if d.status not in ('incomplete', 'pending_review', 'rejected') then
    raise exception 'AURA: approved captains change their vehicle through support' using errcode = '55000';
  end if;
  perform set_config('aura.reason', 'captain resubmitted vehicle', true);

  begin
    if p_vehicle_id is not null then
      select * into v from public.vehicles where id = p_vehicle_id and driver_id = d.id for update;
      if not found then
        raise exception 'AURA: vehicle not found' using errcode = 'P0002';
      end if;
      if v.status not in ('rejected', 'pending_review') then
        raise exception 'AURA: this vehicle can no longer be edited' using errcode = '55000';
      end if;
      update public.vehicles
         set vehicle_class = p_vehicle_class, make = btrim(p_make), model = btrim(p_model), year = p_year,
             color = btrim(p_color), plate_letters = upper(p_plate_letters), plate_number = p_plate_number,
             sequence_number = p_sequence_number, seats = p_seats,
             status = 'pending_review', status_reason = null,
             wasl_status = 'not_submitted', wasl_reference = null, wasl_checked_at = null
       where id = v.id
      returning * into v;
    else
      insert into public.vehicles (driver_id, vehicle_class, make, model, year, color,
                                   plate_letters, plate_number, sequence_number, seats)
      values (d.id, p_vehicle_class, btrim(p_make), btrim(p_model), p_year, btrim(p_color),
              upper(p_plate_letters), p_plate_number, p_sequence_number, p_seats)
      returning * into v;
    end if;
  exception when unique_violation then
    raise exception 'AURA: plate or sequence number is already registered' using errcode = '23505';
  end;

  -- An application already under review: queue the (new) vehicle for the Wasl check too.
  if d.status = 'pending_review' then
    update public.vehicles set wasl_status = 'pending' where id = v.id returning * into v;
  end if;
  update public.drivers set current_vehicle_id = v.id where id = d.id;
  return v;
end;
$$;

revoke execute on function public.driver_save_vehicle(uuid, public.vehicle_class, text, text, integer, text, text, text, text, integer) from public, anon;
grant  execute on function public.driver_save_vehicle(uuid, public.vehicle_class, text, text, integer, text, text, text, text, integer) to authenticated, service_role;
