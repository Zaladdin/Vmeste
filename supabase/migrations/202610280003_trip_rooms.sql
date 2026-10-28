begin;

create schema if not exists vmeste_private;
revoke all on schema vmeste_private from public, anon, authenticated;

create table public.trip_rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  trip jsonb not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index trip_rooms_owner on public.trip_rooms(owner_id);
create table public.trip_room_members (
  room_id uuid not null references public.trip_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key(room_id,user_id)
);
create index trip_room_members_user on public.trip_room_members(user_id,room_id);
create table public.trip_room_people (
  room_id uuid not null,
  person_id text not null check (char_length(person_id) between 1 and 100),
  user_id uuid not null,
  primary key(room_id,person_id),
  unique(room_id,user_id),
  foreign key(room_id,user_id) references public.trip_room_members(room_id,user_id) on delete cascade
);
create table vmeste_private.trip_room_invites (
  room_id uuid primary key references public.trip_rooms(id) on delete cascade,
  code_hash bytea not null unique
);
alter table public.trip_rooms enable row level security;
alter table public.trip_room_members enable row level security;
alter table public.trip_room_people enable row level security;
alter table vmeste_private.trip_room_invites enable row level security;
revoke all on public.trip_rooms,public.trip_room_members,public.trip_room_people,
  vmeste_private.trip_room_invites from public,anon,authenticated;

create function vmeste_private.room_actor() returns uuid
language plpgsql stable set search_path='' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'ROOM_FORBIDDEN'; end if;
  return actor;
end;
$$;
revoke all on function vmeste_private.room_actor() from public,anon,authenticated;

-- This predicate is public only to avoid granting USAGE on the existing private
-- schema to API roles. It reveals only the caller's own membership.
create function public.is_trip_room_member(p_room_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(
    select 1 from public.trip_room_members m
    where m.room_id=p_room_id and m.user_id=(select auth.uid())
  );
$$;
revoke all on function public.is_trip_room_member(uuid) from public,anon;
grant execute on function public.is_trip_room_member(uuid) to authenticated;
grant select on public.trip_rooms,public.trip_room_members,public.trip_room_people to authenticated;
create policy trip_rooms_read_members on public.trip_rooms for select to authenticated
  using (public.is_trip_room_member(id));
create policy trip_room_members_read_members on public.trip_room_members for select to authenticated
  using (public.is_trip_room_member(room_id));
create policy trip_room_people_read_members on public.trip_room_people for select to authenticated
  using (public.is_trip_room_member(room_id));

create function vmeste_private.room_string(value jsonb,minimum integer,maximum integer)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(value)='string' and char_length(value #>> '{}') between minimum and maximum
    and (minimum=0 or char_length(btrim(value #>> '{}'))>=minimum),false);
$$;
revoke all on function vmeste_private.room_string(jsonb,integer,integer) from public,anon,authenticated;

-- Validate the shared plan rather than accepting arbitrary JSON or document blobs.
create function vmeste_private.room_trip_valid(value jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare person jsonb; event jsonb; member jsonb; start_day date; end_day date; event_day date;
  zones text[]; person_ids text[];
begin
  -- Materialize once: pg_timezone_names computes offsets and is expensive when
  -- scanned inside a 1,000-event loop.
  select array_agg(name) into zones from pg_catalog.pg_timezone_names;
  if jsonb_typeof(value) is distinct from 'object'
    or octet_length(value::text)>1048576
    or not(value ?& array['id','title','destination','startDate','endDate','timeZone','members','events'])
    or exists(select 1 from jsonb_object_keys(value) k where k not in ('id','title','destination','startDate','endDate','timeZone','members','events'))
    or not vmeste_private.room_string(value->'id',1,100)
    or not vmeste_private.room_string(value->'title',1,160)
    or not vmeste_private.room_string(value->'destination',1,160)
    or not vmeste_private.room_string(value->'timeZone',1,80)
    or not(value->>'timeZone'=any(zones))
    or coalesce(value->>'startDate','') !~ '^\d{4}-\d{2}-\d{2}$'
    or coalesce(value->>'endDate','') !~ '^\d{4}-\d{2}-\d{2}$'
    or jsonb_typeof(value->'members') is distinct from 'array'
    or jsonb_typeof(value->'events') is distinct from 'array'
  then return false; end if;
  start_day := (value->>'startDate')::date; end_day := (value->>'endDate')::date;
  if end_day<start_day or end_day-start_day>365
    or jsonb_array_length(value->'members')>50 or jsonb_array_length(value->'events')>1000
  then return false; end if;
  for person in select * from jsonb_array_elements(value->'members') loop
    if jsonb_typeof(person) is distinct from 'object'
      or not(person ?& array['id','name'])
      or exists(select 1 from jsonb_object_keys(person) k where k not in ('id','name'))
      or not vmeste_private.room_string(person->'id',1,100)
      or not vmeste_private.room_string(person->'name',1,60)
    then return false; end if;
  end loop;
  select coalesce(array_agg(p->>'id'),array[]::text[]) into person_ids from jsonb_array_elements(value->'members') p;
  if (select count(*)<>count(distinct p->>'id') from jsonb_array_elements(value->'members') p)
    or (select count(*)<>count(distinct e->>'id') from jsonb_array_elements(value->'events') e)
  then return false; end if;
  for event in select * from jsonb_array_elements(value->'events') loop
    if jsonb_typeof(event) is distinct from 'object'
      or not(event ?& array['id','kind','title','date','time','timeZone','location','details','memberIds'])
      or exists(select 1 from jsonb_object_keys(event) k where k not in ('id','kind','title','date','time','timeZone','endLocal','endTimeZone','location','details','memberIds'))
      or not vmeste_private.room_string(event->'id',1,100)
      or not vmeste_private.room_string(event->'kind',1,20)
      or event->>'kind' not in ('flight','stay','transport','activity')
      or not vmeste_private.room_string(event->'title',1,160)
      or not vmeste_private.room_string(event->'timeZone',1,80)
      or not(event->>'timeZone'=any(zones))
      or coalesce(event->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
      or coalesce(event->>'time','') !~ '^([01]\d|2[0-3]):[0-5]\d$'
      or not vmeste_private.room_string(event->'location',0,300)
      or not vmeste_private.room_string(event->'details',0,2000)
      or jsonb_typeof(event->'memberIds') is distinct from 'array'
    then return false; end if;
    event_day := (event->>'date')::date;
    if event_day<start_day or event_day>end_day or jsonb_array_length(event->'memberIds')>50
    then return false; end if;
    for member in select * from jsonb_array_elements(event->'memberIds') loop
      if not vmeste_private.room_string(member,1,100)
        or not(member #>> '{}'=any(person_ids))
      then return false; end if;
    end loop;
    if event ? 'endTimeZone' then
      if not vmeste_private.room_string(event->'endTimeZone',1,80)
        or not(event->>'endTimeZone'=any(zones))
      then return false; end if;
    end if;
    if event ? 'endLocal' then
      if coalesce(event->>'endLocal','') !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$'
        or not(event ? 'endTimeZone') then return false; end if;
      if ((event->>'endLocal')::timestamp at time zone (event->>'endTimeZone')) <
        (((event->>'date')||'T'||(event->>'time'))::timestamp at time zone (event->>'timeZone'))
      then return false; end if;
    end if;
  end loop;
  return true;
exception when others then return false;
end;
$$;
revoke all on function vmeste_private.room_trip_valid(jsonb) from public,anon,authenticated;

create function vmeste_private.room_detail(p_room_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); result jsonb;
begin
  if not exists(select 1 from public.trip_room_members where room_id=p_room_id and user_id=actor)
  then raise exception 'ROOM_NOT_FOUND'; end if;
  select jsonb_build_object('id',r.id,'owner_id',r.owner_id,'trip',r.trip,'revision',r.revision,'updated_at',r.updated_at,
    'members',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'joined_at',m.joined_at) order by m.joined_at,m.user_id)
      from public.trip_room_members m where m.room_id=r.id),'[]'::jsonb),
    'links',coalesce((select jsonb_agg(jsonb_build_object('person_id',p.person_id,'user_id',p.user_id) order by p.person_id)
      from public.trip_room_people p where p.room_id=r.id),'[]'::jsonb)) into result
    from public.trip_rooms r where r.id=p_room_id;
  if result is null then raise exception 'ROOM_NOT_FOUND'; end if;
  return result;
end;
$$;
revoke all on function vmeste_private.room_detail(uuid) from public,anon,authenticated;

create function public.trip_rooms_capability() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin perform vmeste_private.room_actor(); return jsonb_build_object('version',1); end;
$$;
create function public.list_trip_rooms() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'owner_id',r.owner_id,'title',r.trip->>'title',
    'revision',r.revision,'updated_at',r.updated_at) order by r.updated_at desc,r.id),'[]'::jsonb) into result
    from public.trip_rooms r join public.trip_room_members m on m.room_id=r.id where m.user_id=actor;
  return result;
end;
$$;
create function public.read_trip_room(p_room_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$ select vmeste_private.room_detail(p_room_id); $$;

create function public.create_trip_room(p_trip jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); v_room_id uuid; code text := replace(gen_random_uuid()::text,'-','');
begin
  if not vmeste_private.room_trip_valid(p_trip) then raise exception 'ROOM_INVALID_TRIP'; end if;
  perform pg_advisory_xact_lock(hashtextextended('trip-room-user:'||actor::text,0));
  if (select count(*) from public.trip_rooms where owner_id=actor)>=20
    or (select count(*) from public.trip_room_members where user_id=actor)>=50
  then raise exception 'ROOM_LIMIT'; end if;
  insert into public.trip_rooms(owner_id,trip) values(actor,p_trip) returning id into v_room_id;
  insert into public.trip_room_members(room_id,user_id) values(v_room_id,actor);
  insert into vmeste_private.trip_room_invites(room_id,code_hash) values(v_room_id,sha256(convert_to(code,'UTF8')));
  return jsonb_build_object('room',vmeste_private.room_detail(v_room_id),'invite_code',code);
end;
$$;
create function public.join_trip_room(p_invite_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); code text; v_room_id uuid; digest bytea;
begin
  if p_invite_code is null or octet_length(p_invite_code)>128 then raise exception 'ROOM_INVALID_CODE'; end if;
  code := lower(regexp_replace(p_invite_code,'[[:space:]-]','','g'));
  if code !~ '^[0-9a-f]{32}$' then raise exception 'ROOM_INVALID_CODE'; end if;
  digest := sha256(convert_to(code,'UTF8'));
  perform pg_advisory_xact_lock(hashtextextended('trip-room-user:'||actor::text,0));
  select i.room_id into v_room_id from vmeste_private.trip_room_invites i where i.code_hash=digest;
  if v_room_id is null then raise exception 'ROOM_INVALID_CODE'; end if;
  perform 1 from public.trip_rooms r where r.id=v_room_id for update;
  -- Recheck after acquiring the room lock: rotation/removal may have won the race.
  if not exists(select 1 from vmeste_private.trip_room_invites i where i.room_id=v_room_id and i.code_hash=digest)
  then raise exception 'ROOM_INVALID_CODE'; end if;
  if exists(select 1 from public.trip_room_members m where m.room_id=v_room_id and m.user_id=actor)
  then return vmeste_private.room_detail(v_room_id); end if;
  if (select count(*) from public.trip_room_members m where m.user_id=actor)>=50
    or (select count(*) from public.trip_room_members m where m.room_id=v_room_id)>=50
  then raise exception 'ROOM_LIMIT'; end if;
  insert into public.trip_room_members(room_id,user_id) values(v_room_id,actor);
  update public.trip_rooms r set revision=r.revision+1,updated_at=clock_timestamp() where r.id=v_room_id;
  return vmeste_private.room_detail(v_room_id);
end;
$$;
create function public.publish_trip_room(p_room_id uuid,p_trip jsonb,p_expected_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); current public.trip_rooms%rowtype;
begin
  select * into current from public.trip_rooms where id=p_room_id and owner_id=actor for update;
  if not found then raise exception 'ROOM_FORBIDDEN'; end if;
  if p_expected_revision is null or current.revision<>p_expected_revision then raise exception 'ROOM_CONFLICT'; end if;
  if not vmeste_private.room_trip_valid(p_trip) or p_trip->>'id'<>current.trip->>'id'
  then raise exception 'ROOM_INVALID_TRIP'; end if;
  update public.trip_rooms set trip=p_trip,revision=revision+1,updated_at=clock_timestamp() where id=p_room_id;
  delete from public.trip_room_people p where p.room_id=p_room_id
    and not exists(select 1 from jsonb_array_elements(p_trip->'members') person where person->>'id'=p.person_id);
  return vmeste_private.room_detail(p_room_id);
end;
$$;
create function public.link_trip_room_person(p_room_id uuid,p_person_id text,p_user_id uuid default null,p_expected_revision integer default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); current public.trip_rooms%rowtype;
begin
  select * into current from public.trip_rooms where id=p_room_id and owner_id=actor for update;
  if not found then raise exception 'ROOM_FORBIDDEN'; end if;
  if p_expected_revision is null or current.revision<>p_expected_revision then raise exception 'ROOM_CONFLICT'; end if;
  if p_person_id is null or not exists(select 1 from jsonb_array_elements(current.trip->'members') p where p->>'id'=p_person_id)
  then raise exception 'ROOM_LINK_CONFLICT'; end if;
  if p_user_id is null then
    delete from public.trip_room_people where room_id=p_room_id and person_id=p_person_id;
  else
    if not exists(select 1 from public.trip_room_members where room_id=p_room_id and user_id=p_user_id)
      or exists(select 1 from public.trip_room_people where room_id=p_room_id and user_id=p_user_id and person_id<>p_person_id)
    then raise exception 'ROOM_LINK_CONFLICT'; end if;
    insert into public.trip_room_people(room_id,person_id,user_id) values(p_room_id,p_person_id,p_user_id)
      on conflict(room_id,person_id) do update set user_id=excluded.user_id;
  end if;
  update public.trip_rooms set revision=revision+1,updated_at=clock_timestamp() where id=p_room_id;
  return vmeste_private.room_detail(p_room_id);
end;
$$;
create function public.rotate_trip_room_invite(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); code text := replace(gen_random_uuid()::text,'-','');
begin
  perform 1 from public.trip_rooms where id=p_room_id and owner_id=actor for update;
  if not found then raise exception 'ROOM_FORBIDDEN'; end if;
  update vmeste_private.trip_room_invites set code_hash=sha256(convert_to(code,'UTF8')) where room_id=p_room_id;
  update public.trip_rooms set revision=revision+1,updated_at=clock_timestamp() where id=p_room_id;
  return jsonb_build_object('invite_code',code);
end;
$$;
create function public.leave_trip_room(p_room_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); owner uuid;
begin
  select owner_id into owner from public.trip_rooms where id=p_room_id for update;
  if owner=actor then raise exception 'ROOM_OWNER_CANNOT_LEAVE'; end if;
  if not exists(select 1 from public.trip_room_members where room_id=p_room_id and user_id=actor)
  then raise exception 'ROOM_NOT_FOUND'; end if;
  delete from public.trip_room_members where room_id=p_room_id and user_id=actor;
  update public.trip_rooms set revision=revision+1,updated_at=clock_timestamp() where id=p_room_id;
end;
$$;
create function public.remove_trip_room_member(p_room_id uuid,p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor(); code text := replace(gen_random_uuid()::text,'-','');
begin
  perform 1 from public.trip_rooms where id=p_room_id and owner_id=actor for update;
  if not found then raise exception 'ROOM_FORBIDDEN'; end if;
  if p_user_id=actor then raise exception 'ROOM_OWNER_CANNOT_LEAVE'; end if;
  delete from public.trip_room_members where room_id=p_room_id and user_id=p_user_id;
  if found then
    update vmeste_private.trip_room_invites set code_hash=sha256(convert_to(code,'UTF8')) where room_id=p_room_id;
    update public.trip_rooms set revision=revision+1,updated_at=clock_timestamp() where id=p_room_id;
  end if;
  return vmeste_private.room_detail(p_room_id);
end;
$$;
create function public.delete_trip_room(p_room_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := vmeste_private.room_actor();
begin
  delete from public.trip_rooms where id=p_room_id and owner_id=actor;
  if not found then raise exception 'ROOM_FORBIDDEN'; end if;
end;
$$;

revoke all on function public.trip_rooms_capability(),public.list_trip_rooms(),public.read_trip_room(uuid),
  public.create_trip_room(jsonb),public.join_trip_room(text),public.publish_trip_room(uuid,jsonb,integer),
  public.link_trip_room_person(uuid,text,uuid,integer),public.rotate_trip_room_invite(uuid),public.leave_trip_room(uuid),
  public.remove_trip_room_member(uuid,uuid),public.delete_trip_room(uuid) from public,anon;
grant execute on function public.trip_rooms_capability(),public.list_trip_rooms(),public.read_trip_room(uuid),
  public.create_trip_room(jsonb),public.join_trip_room(text),public.publish_trip_room(uuid,jsonb,integer),
  public.link_trip_room_person(uuid,text,uuid,integer),public.rotate_trip_room_invite(uuid),public.leave_trip_room(uuid),
  public.remove_trip_room_member(uuid,uuid),public.delete_trip_room(uuid) to authenticated;

comment on table public.trip_rooms is 'Explicitly published shared plan snapshots; private originals and local trips remain outside rooms.';
comment on table vmeste_private.trip_room_invites is 'Only invitation hashes. Codes are returned on creation/rotation and never exposed to room readers.';
notify pgrst, 'reload schema';
commit;
