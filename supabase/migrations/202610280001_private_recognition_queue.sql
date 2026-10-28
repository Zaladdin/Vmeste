begin;

create schema if not exists vmeste_private;
revoke all on schema vmeste_private from public, anon, authenticated;

create table public.recognition_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_id uuid not null,
  document_id uuid not null,
  trip_id text not null check (char_length(trip_id) between 1 and 100),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  object_path text not null,
  name text not null check (char_length(name) between 1 and 255 and name !~ '[[:cntrl:]]'),
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size bigint not null check (size between 1 and 20971520),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  result jsonb,
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  worker_token uuid,
  constraint recognition_job_object_path check (object_path = user_id::text || '/' || id::text || '/document'),
  constraint recognition_job_attempt_unique unique (user_id, attempt_id),
  constraint recognition_job_state check (
    (status = 'queued' and worker_token is null and claimed_at is null and completed_at is null and result is null and error is null)
    or (status = 'processing' and worker_token is not null and claimed_at is not null and completed_at is null and result is null and error is null)
    or (status = 'completed' and worker_token is not null and claimed_at is not null and completed_at is not null and result is not null and error is null)
    or (status = 'failed' and worker_token is not null and claimed_at is not null and completed_at is not null and result is null and error is not null)
  )
);

create index recognition_jobs_owner_created on public.recognition_jobs(user_id, created_at desc);
create index recognition_jobs_claim on public.recognition_jobs(user_id, created_at, id) where status = 'queued';
alter table public.recognition_jobs enable row level security;
revoke all on public.recognition_jobs from public, anon, authenticated;
grant select on public.recognition_jobs to authenticated;
create policy recognition_jobs_read_own on public.recognition_jobs
  for select to authenticated using (user_id = (select auth.uid()));

-- Only the four bounded RPCs below can mutate jobs. Browser and local worker
-- share the owner's Auth identity; no elevated service-role key is needed.
create function vmeste_private.valid_recognition_result(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  event jsonb;
  warning jsonb;
  usage jsonb;
  field text;
  limit_chars integer;
begin
  if value is null or jsonb_typeof(value) <> 'object' then return false; end if;
  if octet_length(value::text) > 262144 or not value ?& array['events', 'warnings']
    or exists (select 1 from jsonb_object_keys(value) as keys(key) where key not in ('events', 'warnings', 'usage'))
    or jsonb_typeof(value->'events') <> 'array' or jsonb_typeof(value->'warnings') <> 'array'
    then return false; end if;
  if jsonb_array_length(value->'events') > 50 or jsonb_array_length(value->'warnings') > 20 then return false; end if;
  for event in select * from jsonb_array_elements(value->'events') loop
    if jsonb_typeof(event) <> 'object' then return false; end if;
    if not event ?& array['kind','title','date','time','timeZone','endDate','endTime','endTimeZone','location','details','needsReview','reviewReason']
      or (select count(*) from jsonb_object_keys(event)) <> 12
      or event->>'kind' not in ('flight','stay','transport')
      or jsonb_typeof(event->'kind') <> 'string'
      or jsonb_typeof(event->'needsReview') <> 'boolean'
      then return false; end if;
    foreach field in array array['title','location','details'] loop
      limit_chars := case field when 'title' then 160 when 'location' then 300 else 2000 end;
      if jsonb_typeof(event->field) <> 'string' or char_length(event->>field) > limit_chars then return false; end if;
    end loop;
    foreach field in array array['date','time','timeZone','endDate','endTime','endTimeZone','reviewReason'] loop
      limit_chars := case when field in ('date','endDate') then 10 when field in ('time','endTime') then 5 when field = 'reviewReason' then 500 else 80 end;
      if jsonb_typeof(event->field) not in ('null','string') or char_length(event->>field) > limit_chars then return false; end if;
    end loop;
  end loop;
  for warning in select * from jsonb_array_elements(value->'warnings') loop
    if jsonb_typeof(warning) <> 'string' or char_length(warning #>> '{}') > 500 then return false; end if;
  end loop;
  if value ? 'usage' then
    usage := value->'usage';
    if jsonb_typeof(usage) <> 'object' then return false; end if;
    if not usage ?& array['provider','inputTokens','outputTokens']
      or usage->>'provider' is distinct from 'codex'
      or exists (select 1 from jsonb_object_keys(usage) as keys(key) where key not in ('provider','inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'))
      then return false; end if;
    foreach field in array array['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'] loop
      if usage ? field then
        if jsonb_typeof(usage->field) <> 'number' then return false; end if;
        if (usage->>field)::numeric < 0 or (usage->>field)::numeric > 9007199254740991
          or trunc((usage->>field)::numeric) <> (usage->>field)::numeric then return false; end if;
      end if;
    end loop;
    if (usage->>'inputTokens')::numeric + (usage->>'outputTokens')::numeric > 9007199254740991
      or coalesce((usage->>'cachedInputTokens')::numeric,0) > (usage->>'inputTokens')::numeric
      or coalesce((usage->>'reasoningOutputTokens')::numeric,0) > (usage->>'outputTokens')::numeric then return false; end if;
  end if;
  return true;
end;
$$;
revoke all on function vmeste_private.valid_recognition_result(jsonb) from public, anon, authenticated;

create function public.enqueue_recognition_job(
  p_id uuid, p_attempt_id uuid, p_document_id uuid, p_trip_id text,
  p_fingerprint text, p_name text, p_mime_type text, p_size bigint
)
returns setof public.recognition_jobs language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
  object_name text;
  previous public.recognition_jobs;
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_id is null or p_attempt_id is null or p_document_id is null or p_trip_id is null or char_length(p_trip_id) not between 1 and 100
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_name is null or char_length(p_name) not between 1 and 255 or p_name ~ '[[:cntrl:]]'
    or p_mime_type is null or p_mime_type not in ('application/pdf','image/jpeg','image/png','image/webp')
    or p_size is null or p_size not between 1 and 20971520 then
    raise exception 'Invalid document metadata' using errcode = '22023';
  end if;
  object_name := owner::text || '/' || p_id::text || '/document';
  -- Serialize only identical owner/idempotency keys, so simultaneous duplicate
  -- requests return the same row instead of racing into a unique violation.
  perform pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_attempt_id::text, 0));
  select * into previous from public.recognition_jobs where user_id = owner and attempt_id = p_attempt_id;
  if found then
    if previous.id <> p_id or previous.document_id <> p_document_id or previous.trip_id <> p_trip_id
      or previous.fingerprint <> p_fingerprint or previous.name <> p_name or previous.mime_type <> p_mime_type or previous.size <> p_size then
      raise exception 'Idempotency key already used' using errcode = '22023';
    end if;
    return next previous;
    return;
  end if;
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'vmeste-documents' and o.name = object_name
      and o.metadata->>'size' = p_size::text and o.metadata->>'mimetype' = p_mime_type
  ) then raise exception 'Uploaded document not found or metadata differs' using errcode = '22023'; end if;
  return query insert into public.recognition_jobs(id,user_id,attempt_id,document_id,trip_id,fingerprint,object_path,name,mime_type,size)
    values(p_id,owner,p_attempt_id,p_document_id,p_trip_id,p_fingerprint,object_name,p_name,p_mime_type,p_size)
    returning *;
end;
$$;

create function public.claim_recognition_job()
returns setof public.recognition_jobs language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid();
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  return query with candidate as (
    select id from public.recognition_jobs where user_id = owner and status = 'queued'
      order by created_at, id limit 1 for update skip locked
  ) update public.recognition_jobs j set status = 'processing', claimed_at = now(), worker_token = gen_random_uuid()
    where j.id = (select id from candidate) and j.user_id = owner and j.status = 'queued' returning j.*;
end;
$$;

create function public.complete_recognition_job(p_id uuid, p_worker_token uuid, p_result jsonb)
returns setof public.recognition_jobs language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid();
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not vmeste_private.valid_recognition_result(p_result) then raise exception 'Invalid recognition result' using errcode = '22023'; end if;
  return query update public.recognition_jobs j set status = 'completed', result = p_result, completed_at = now()
    where j.id = p_id and j.user_id = owner and j.status = 'processing' and j.worker_token = p_worker_token returning j.*;
  if not found then raise exception 'Job lease is not active' using errcode = '42501'; end if;
end;
$$;

create function public.fail_recognition_job(p_id uuid, p_worker_token uuid, p_error text)
returns setof public.recognition_jobs language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); safe_error text;
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  safe_error := case p_error
    when 'daily_limit' then 'Дневной лимит распознавания исчерпан. Повторите позже.'
    when 'invalid_document' then 'Не удалось прочитать документ. Загрузите оригинал PDF или изображения.'
    when 'worker_unavailable' then 'Локальный обработчик недоступен. Проверьте его на компьютере.'
    when 'recognition_failed' then 'Не удалось распознать документ. Проверьте локальный обработчик и повторите попытку.'
    else null end;
  if safe_error is null then raise exception 'Invalid error code' using errcode = '22023'; end if;
  return query update public.recognition_jobs j set status = 'failed', error = safe_error, completed_at = now()
    where j.id = p_id and j.user_id = owner and j.status = 'processing' and j.worker_token = p_worker_token returning j.*;
  if not found then raise exception 'Job lease is not active' using errcode = '42501'; end if;
end;
$$;

revoke all on function public.enqueue_recognition_job(uuid,uuid,uuid,text,text,text,text,bigint) from public, anon, authenticated;
revoke all on function public.claim_recognition_job() from public, anon, authenticated;
revoke all on function public.complete_recognition_job(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.fail_recognition_job(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.enqueue_recognition_job(uuid,uuid,uuid,text,text,text,text,bigint) to authenticated;
grant execute on function public.claim_recognition_job() to authenticated;
grant execute on function public.complete_recognition_job(uuid,uuid,jsonb) to authenticated;
grant execute on function public.fail_recognition_job(uuid,uuid,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('vmeste-documents','vmeste-documents',false,20971520,array['application/pdf','image/jpeg','image/png','image/webp']);
create policy vmeste_documents_read_own on storage.objects for select to authenticated
  using (bucket_id = 'vmeste-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy vmeste_documents_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'vmeste-documents' and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ ('^' || (select auth.uid())::text || '/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/document$'));
create policy vmeste_documents_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'vmeste-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- No UPDATE policy: uploads are immutable and SDK upload must use upsert:false.

comment on table public.recognition_jobs is 'Private per-user recognition queue; only RPC mutations, processing jobs never auto-reclaimed.';
comment on function public.claim_recognition_job() is 'Claims at most one queued job for auth.uid with SKIP LOCKED; no automatic retry after a crash.';

commit;
