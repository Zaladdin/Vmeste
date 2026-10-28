-- LOCAL DISPOSABLE DATABASE ONLY. This file creates an auth stub; never run it
-- in a real Supabase project. Example (existing postgres:16 image):
-- docker run -d --name vmeste-rooms-db-test --network none \
--   --tmpfs /var/lib/postgresql/data:rw,size=256m \
--   -e POSTGRES_DB=vmeste_rooms_test -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
-- docker cp supabase vmeste-rooms-db-test:/tmp/supabase
-- docker exec vmeste-rooms-db-test psql -U postgres -d vmeste_rooms_test \
--   -v ON_ERROR_STOP=1 -f /tmp/supabase/tests/trip_rooms.sql
-- docker rm -f vmeste-rooms-db-test
\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'vmeste_rooms_test' then
    raise exception 'This fixture requires disposable database vmeste_rooms_test';
  end if;
end $$;
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;
\ir ../migrations/202610280003_trip_rooms.sql

begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %',label; end if; end;
$$;
create function pg_temp.expect_error(command text,expected text) returns void language plpgsql as $$
begin
  execute command;
  raise exception 'Expected error % but statement succeeded',expected;
exception when others then
  if sqlerrm<>expected and sqlstate<>expected then raise; end if;
end;
$$;

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
select '{"id":"private-trip-a","title":"Shared test trip","destination":"Baku","startDate":"2027-05-10","endDate":"2027-05-12","timeZone":"Asia/Baku","members":[{"id":"person-a","name":"Alex Example"},{"id":"person-b","name":"Elena Example"}],"events":[{"id":"flight-a","kind":"flight","title":"Baku flight","date":"2027-05-10","time":"10:00","timeZone":"Asia/Baku","location":"GYD","details":"Shared plan only","memberIds":["person-a","person-b"]}]}' as trip \gset

select pg_temp.assert(not has_schema_privilege('authenticated','vmeste_private','USAGE'),'private schema is not exposed');
select pg_temp.assert(not has_function_privilege('anon','public.create_trip_room(jsonb)','EXECUTE'),'anon cannot create');
select pg_temp.assert(not has_function_privilege('anon','public.is_trip_room_member(uuid)','EXECUTE'),'anon cannot probe membership');
set local role anon;
select pg_temp.expect_error('select public.trip_rooms_capability()','42501');
select pg_temp.expect_error('select * from public.trip_rooms','42501');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.expect_error('select public.trip_rooms_capability()','ROOM_FORBIDDEN');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select pg_temp.assert(public.trip_rooms_capability()='{"version":1}'::jsonb,'capability');
select public.create_trip_room(:'trip'::jsonb) as created \gset
select (:'created'::jsonb->'room'->>'id') as room_id,(:'created'::jsonb->>'invite_code') as code \gset
select pg_temp.assert(length(:'code')=32,'high entropy code has expected format');
select pg_temp.assert(jsonb_array_length(public.list_trip_rooms())=1,'owner room list');
select pg_temp.assert((public.read_trip_room(:'room_id') ->> 'revision')::integer=1,'initial revision');
select pg_temp.assert(jsonb_array_length(public.read_trip_room(:'room_id')->'members')=1,'owner is a member');
select pg_temp.assert(not(public.read_trip_room(:'room_id') ? 'invite_code'),'read response contains no secret');
select pg_temp.expect_error('select * from vmeste_private.trip_room_invites','42501');
select pg_temp.expect_error(format('update public.trip_rooms set trip=%L::jsonb where id=%L::uuid',:'trip',:'room_id'),'42501');
select pg_temp.expect_error(format('insert into public.trip_room_members(room_id,user_id) values(%L,%L)',:'room_id','33333333-3333-4333-8333-333333333333'),'42501');
select pg_temp.expect_error(format('select public.leave_trip_room(%L)',:'room_id'),'ROOM_OWNER_CANNOT_LEAVE');
select pg_temp.expect_error(format('select public.create_trip_room(%L::jsonb)',(:'trip'::jsonb||'{"blob":"private PDF must not be shared"}'::jsonb)::text),'ROOM_INVALID_TRIP');
select pg_temp.expect_error(format('select public.create_trip_room(%L::jsonb)',jsonb_set(:'trip'::jsonb,'{events,0,memberIds}','["unknown-person"]')::text),'ROOM_INVALID_TRIP');

-- B cannot read by room UUID; only the secret code can grant ordinary membership.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.assert(public.list_trip_rooms()='[]'::jsonb,'outsider list empty');
select pg_temp.assert((select count(*)=0 from public.trip_rooms),'RLS hides plans');
select pg_temp.assert((select count(*)=0 from public.trip_room_members),'RLS hides member IDs');
select pg_temp.expect_error(format('select public.read_trip_room(%L)',:'room_id'),'ROOM_NOT_FOUND');
select pg_temp.expect_error('select public.join_trip_room(''00000000000000000000000000000000'')','ROOM_INVALID_CODE');
select pg_temp.expect_error(format('select public.join_trip_room(%L)',:'room_id'),'ROOM_INVALID_CODE');
select public.join_trip_room('  '||upper(substr(:'code',1,16))||'-'||upper(substr(:'code',17))||'  ') as joined \gset
select pg_temp.assert((:'joined'::jsonb->>'revision')::integer=2,'join increments revision');
select pg_temp.assert(public.read_trip_room(:'room_id')->'trip'=:'trip'::jsonb,'member reads shared plan');
select pg_temp.assert(jsonb_array_length(public.join_trip_room(:'code')->'members')=2,'repeat join is idempotent');
select pg_temp.expect_error(format('select public.publish_trip_room(%L,%L::jsonb,2)',:'room_id',:'trip'),'ROOM_FORBIDDEN');
select pg_temp.expect_error(format('select public.link_trip_room_person(%L,''person-b'',''22222222-2222-4222-8222-222222222222'',2)',:'room_id'),'ROOM_FORBIDDEN');
select pg_temp.expect_error(format('select public.rotate_trip_room_invite(%L)',:'room_id'),'ROOM_FORBIDDEN');
select pg_temp.expect_error(format('select public.remove_trip_room_member(%L,''11111111-1111-4111-8111-111111111111'')',:'room_id'),'ROOM_FORBIDDEN');
select pg_temp.expect_error(format('select public.delete_trip_room(%L)',:'room_id'),'ROOM_FORBIDDEN');

select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select pg_temp.expect_error(format('select public.publish_trip_room(%L,%L::jsonb,1)',:'room_id',:'trip'),'ROOM_CONFLICT');
select public.link_trip_room_person(:'room_id','person-b','22222222-2222-4222-8222-222222222222',2) as linked \gset
select pg_temp.assert(:'linked'::jsonb->'links'='[{"person_id":"person-b","user_id":"22222222-2222-4222-8222-222222222222"}]'::jsonb,'owner binds a document person to joined account');
select pg_temp.expect_error(format('select public.link_trip_room_person(%L,''person-a'',''22222222-2222-4222-8222-222222222222'',3)',:'room_id'),'ROOM_LINK_CONFLICT');
select pg_temp.expect_error(format('select public.link_trip_room_person(%L,''person-a'',''33333333-3333-4333-8333-333333333333'',3)',:'room_id'),'ROOM_LINK_CONFLICT');
select public.publish_trip_room(:'room_id',:'trip'::jsonb,3) as published \gset
select pg_temp.assert((:'published'::jsonb->>'revision')::integer=4,'owner publishes with expected revision');

select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
select pg_temp.expect_error(format('select public.read_trip_room(%L)',:'room_id'),'ROOM_NOT_FOUND');
select pg_temp.assert((select count(*)=0 from public.trip_room_people),'RLS hides person-account links');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.remove_trip_room_member(:'room_id','22222222-2222-4222-8222-222222222222') as removed \gset
select pg_temp.assert(:'removed'::jsonb->'links'='[]'::jsonb,'removal clears identity binding');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.expect_error(format('select public.read_trip_room(%L)',:'room_id'),'ROOM_NOT_FOUND');
select pg_temp.expect_error(format('select public.join_trip_room(%L)',:'code'),'ROOM_INVALID_CODE');
select pg_temp.assert(public.list_trip_rooms()='[]'::jsonb,'revoked user has no room');
select pg_temp.assert((select count(*)=0 from public.trip_rooms),'revoked user cannot direct-read snapshot');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.rotate_trip_room_invite(:'room_id')->>'invite_code' as rotated \gset
select pg_temp.assert(:'rotated'<>:'code','rotation issues new code');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.assert(jsonb_array_length(public.join_trip_room(:'rotated')->'members')=2,'new invitation works');
select public.leave_trip_room(:'room_id');
select pg_temp.expect_error(format('select public.read_trip_room(%L)',:'room_id'),'ROOM_NOT_FOUND');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.delete_trip_room(:'room_id');
select pg_temp.assert(public.list_trip_rooms()='[]'::jsonb,'delete removes room membership');

-- Supported collection limit stays valid; catches per-event catalog scans too.
select public.create_trip_room(jsonb_set(:'trip'::jsonb,'{events}',(
  select jsonb_agg(jsonb_set(:'trip'::jsonb->'events'->0,'{id}',to_jsonb('event-'||n)))
  from generate_series(1,1000) n
)))->'room'->>'id' as large_room \gset
select pg_temp.assert(jsonb_array_length(public.read_trip_room(:'large_room')->'trip'->'events')=1000,'supported 1000-event snapshot');
select public.delete_trip_room(:'large_room');

-- Independent room and per-user membership caps; all data remain disposable.
reset role;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select public.create_trip_room(:'trip'::jsonb) as capacity_room \gset
select set_config('vmeste.test_room_invite',:'capacity_room'::jsonb->>'invite_code',true);
do $$ declare i integer; actor uuid; begin
  for i in 1..49 loop
    actor := gen_random_uuid();
    insert into auth.users(id) values(actor);
    perform set_config('request.jwt.claim.sub',actor::text,true);
    perform public.join_trip_room(current_setting('vmeste.test_room_invite'));
  end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
select pg_temp.expect_error(format('select public.join_trip_room(%L)',:'capacity_room'::jsonb->>'invite_code'),'ROOM_LIMIT');
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select pg_temp.assert(jsonb_array_length(public.read_trip_room((:'capacity_room'::jsonb->'room'->>'id')::uuid)->'members')=50,'room cap is 50');
reset role;
select set_config('vmeste.test_trip',:'trip',true);
do $$ declare i integer; creator uuid; created jsonb; begin
  for i in 1..51 loop
    creator := gen_random_uuid();
    insert into auth.users(id) values(creator);
    perform set_config('request.jwt.claim.sub',creator::text,true);
    created := public.create_trip_room(current_setting('vmeste.test_trip')::jsonb);
    perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
    if i<=50 then
      perform public.join_trip_room(created->>'invite_code');
    else
      perform set_config('vmeste.test_over_capacity_invite',created->>'invite_code',true);
    end if;
  end loop;
end $$;
set local role authenticated;
select pg_temp.expect_error(format('select public.join_trip_room(%L)',current_setting('vmeste.test_over_capacity_invite')),'ROOM_LIMIT');
select pg_temp.assert(jsonb_array_length(public.list_trip_rooms())=50,'per-user membership cap is 50');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);

-- The per-owner cap is enforced in the database, not only by the client UI.
select count(public.create_trip_room(:'trip'::jsonb)) from generate_series(1,20);
select pg_temp.expect_error(format('select public.create_trip_room(%L::jsonb)',:'trip'),'ROOM_LIMIT');
select pg_temp.assert(jsonb_array_length(public.list_trip_rooms())=20,'owner cap leaves existing rooms intact');
reset role;
rollback;
\echo 'PASS trip rooms: auth, RLS, ownership, invitations, links, revisions, revocation and all three capacity limits'
