begin;
-- Explicit terminal transitions only. Never put uncertain work back in the queue.
create function public.stop_recognition_job(p_id uuid, p_processing boolean default false)
returns setof public.recognition_jobs language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid();
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  return query update public.recognition_jobs
    set status = 'failed', completed_at = now(),
        claimed_at = coalesce(claimed_at, now()),
        worker_token = coalesce(worker_token, gen_random_uuid()),
        error = case when p_processing then 'Обработка прервана вручную. Результат неизвестен; повтор может снова расходовать лимит.'
                     else 'Задание отменено до начала обработки.' end
    where id = p_id and user_id = owner
      and ((not p_processing and status = 'queued')
        or (p_processing and status = 'processing' and claimed_at < now() - interval '15 minutes'))
    returning *;
end;
$$;
revoke all on function public.stop_recognition_job(uuid,boolean) from public, anon;
grant execute on function public.stop_recognition_job(uuid,boolean) to authenticated;
comment on function public.stop_recognition_job(uuid,boolean) is 'Owner-only compare-and-set cancellation/recovery; a stale worker cannot complete failed work; retry requires a separate enqueue.';
create table public.worker_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state text not null check (state in ('available','paused','server_unavailable')),
  remaining integer check (remaining between 0 and 100),
  daily_limit integer check (daily_limit between 0 and 100),
  observed_at timestamptz not null default now()
);
alter table public.worker_status enable row level security;
revoke all on public.worker_status from public, anon, authenticated;
grant select on public.worker_status to authenticated;
create policy worker_status_read_own on public.worker_status for select to authenticated
  using (user_id = (select auth.uid()));
create function public.report_worker_status(p_state text, p_remaining integer, p_limit integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.worker_status(user_id,state,remaining,daily_limit,observed_at)
    values(auth.uid(),p_state,p_remaining,p_limit,now())
    on conflict(user_id) do update set state = excluded.state, remaining = excluded.remaining,
      daily_limit = excluded.daily_limit, observed_at = now();
end;
$$;
revoke all on function public.report_worker_status(text,integer,integer) from public, anon;
grant execute on function public.report_worker_status(text,integer,integer) to authenticated;
commit;
