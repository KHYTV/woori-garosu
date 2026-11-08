-- 우리동네가로수 커뮤니티: 기간별 순위·현황 숫자·이웃 소식·다른 보호자가 돌보는 나무 (pipeline/sns_sql.py가 생성)
-- sns_schema.sql을 먼저 실행한 같은 Supabase 프로젝트에서, 대시보드 → SQL Editor에 붙여 넣고 실행한다. 다시 실행해도 안전하다.
-- 이 파일을 실행하기 전에는 앱이 함수가 없는 것(404)을 한 번 보고 조용히 예전 '동네 순위(30일)'만 보여 준다.
-- sns_schema.sql의 표·보기·정책은 바꾸지 않는다. 새 표 guardian_prefs 하나와 함수만 더한다.
--
-- 공개 범위(온라인에 참여한 사람끼리만: 함수는 authenticated에게만 열고 anon에게는 닫는다)
--   * 보이는 것: 동 이름, 활동 종류·시각(분 단위), 나무 관리번호·이름·수종, 점수·감축(추정)량 집계,
--     닉네임은 '순위·소식에 닉네임 보이기'를 켠 사람만(기본 꺼짐 → '익명 보호자'). 본인 줄은 본인에게만 닉네임이 보인다.
--   * 보이지 않는 것: 사진·메모·위치(원래 서버에 없다), 보호자 id, 닉네임을 끈 사람의 닉네임·동.
--   * 이웃 소식(community_feed)은 최근 7일·최대 50건이고 나무 관리번호를 돌려주지 않는다(소식 → 나무 위치 → 그 시각 그 자리의 사람으로 이어지지 않게).
--   * 지도(community_trees_in_view)는 보호자 수·마지막 활동 날짜(시각 없음)·최근 30일 활동 수만 돌려주고 이름·닉네임은 주지 않는다.
--     서버에는 나무 좌표가 없어서, 앱이 지도 화면 범위 안 나무의 관리번호(최대 3000개)를 보내 묻는다.
--   * 순위는 최대 50줄 + 내 줄. 기간은 한국 시간으로 오늘·이번 주(월요일부터)·이번 달·올해.

-- 닉네임 공개 선택(기본 꺼짐). 표는 직접 읽고 쓸 수 없고 아래 함수로만 바꾼다
create table if not exists public.guardian_prefs (
  guardian_id   uuid primary key references public.guardians (id) on delete cascade,
  show_nickname boolean not null default false,
  updated_at    timestamptz not null default now()
);
alter table public.guardian_prefs enable row level security;
revoke all on public.guardian_prefs from anon, authenticated;

-- 기간의 시작 시각(한국 시간). 모르는 기간이면 null → 결과 없음
create or replace function public.community_period_start(p_period text)
returns timestamptz
language sql stable
set search_path = public
as $$
  select case when p_period in ('day', 'week', 'month', 'year')
              then date_trunc(p_period, now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' end;
$$;

-- 내 닉네임 공개 여부
create or replace function public.community_prefs()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select p.show_nickname from public.guardian_prefs p where p.guardian_id = auth.uid()), false);
$$;

create or replace function public.community_set_prefs(p_show_nickname boolean)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if not exists (select 1 from public.guardians g where g.id = auth.uid()) then
    raise exception 'join first';
  end if;
  insert into public.guardian_prefs (guardian_id, show_nickname, updated_at)
  values (auth.uid(), coalesce(p_show_nickname, false), now())
  on conflict (guardian_id) do update set show_nickname = excluded.show_nickname, updated_at = now();
  return coalesce(p_show_nickname, false);
end;
$$;

-- 기간별 순위: p_target = 'dong'(동네) | 'guardian'(보호자) | 'tree'(나무). 상위 p_limit줄(최대 50) + 내 줄
create or replace function public.community_rankings(p_period text default 'week', p_target text default 'dong', p_limit int default 20)
returns table (rank int, name text, tree_id text, species text, dong text, guardians int, trees int, activities int, points int, kg numeric, is_me boolean)
language sql stable security definer
set search_path = public
as $$
  with acts as (
    select a.guardian_id, a.tree_id, a.dong, a.points, a.kg
      from public.activities a
     where a.t >= public.community_period_start(p_period) and a.t <= now() + interval '5 minutes'
  ),
  shown as (  -- 닉네임을 보여도 되는 보호자: 본인 또는 공개를 켠 사람
    select g.id, g.nickname, g.dong
      from public.guardians g left join public.guardian_prefs p on p.guardian_id = g.id
     where g.id = auth.uid() or coalesce(p.show_nickname, false)
  ),
  ranked as (
    select rank() over (order by sum(x.points) desc, count(distinct x.guardian_id) desc)::int as rnk,
           x.dong as nm, null::text as tid, null::text as sp, x.dong as dg,
           count(distinct x.guardian_id)::int as ng, count(distinct x.tree_id)::int as nt, count(*)::int as na,
           sum(x.points)::int as pts, coalesce(sum(x.kg), 0)::numeric(12,3) as co2,
           coalesce(x.dong = (select g.dong from public.guardians g where g.id = auth.uid()), false) as mine
      from acts x
     where p_target = 'dong' and x.dong is not null
     group by x.dong
    union all
    select rank() over (order by sum(x.points) desc, count(*) desc)::int,
           s.nickname, null::text, null::text, s.dong,
           1, count(distinct x.tree_id)::int, count(*)::int,
           sum(x.points)::int, coalesce(sum(x.kg), 0)::numeric(12,3),
           x.guardian_id = auth.uid()
      from acts x left join shown s on s.id = x.guardian_id
     where p_target = 'guardian'
     group by x.guardian_id, s.nickname, s.dong
    union all
    select rank() over (order by count(*) desc, sum(x.points) desc)::int,
           (select f.tree_name from public.tree_follows f where f.tree_id = x.tree_id order by f.since asc limit 1),
           x.tree_id,
           (select f.species from public.tree_follows f where f.tree_id = x.tree_id and f.species is not null order by f.since asc limit 1),
           max(x.dong),
           count(distinct x.guardian_id)::int, 1, count(*)::int,
           sum(x.points)::int, coalesce(sum(x.kg), 0)::numeric(12,3),
           exists (select 1 from public.tree_follows f where f.tree_id = x.tree_id and f.guardian_id = auth.uid())
      from acts x
     where p_target = 'tree'
     group by x.tree_id
  )
  select r.rnk, r.nm, r.tid, r.sp, r.dg, r.ng, r.nt, r.na, r.pts, r.co2, r.mine
    from ranked r
   where r.rnk <= least(greatest(coalesce(p_limit, 20), 1), 50) or r.mine
   order by r.rnk, r.nm
   limit 60;
$$;

-- 현황 숫자: 오늘·이번 주에 새로 친구가 된 나무(그 나무의 첫 친구 맺기가 기간 안), 활동한 보호자, 활동 수, 감축(추정)량
-- + 지금까지 친구가 된 나무·참여한 보호자 수
create or replace function public.community_stats()
returns table (period text, since timestamptz, new_trees int, active_guardians int, activities int, kg numeric, total_trees int, total_guardians int)
language sql stable security definer
set search_path = public
as $$
  select w.p, w.t0,
         (select count(*)::int from (select f.tree_id from public.tree_follows f group by f.tree_id
                                       having min(f.since) >= w.t0 and min(f.since) <= now() + interval '5 minutes') x),
         (select count(distinct a.guardian_id)::int from public.activities a where a.t >= w.t0 and a.t <= now() + interval '5 minutes'),
         (select count(*)::int from public.activities a where a.t >= w.t0 and a.t <= now() + interval '5 minutes'),
         (select coalesce(sum(a.kg), 0)::numeric(12,3) from public.activities a where a.t >= w.t0 and a.t <= now() + interval '5 minutes'),
         (select count(distinct f.tree_id)::int from public.tree_follows f),
         (select count(*)::int from public.guardians g)
    from (select v.p, public.community_period_start(v.p) as t0 from (values ('day'), ('week')) as v(p)) w;
$$;

-- 이웃 소식: 최근 7일 활동, 최대 50건. 사진·메모·위치·나무 관리번호 없음, 시각은 분 단위
create or replace function public.community_feed(p_limit int default 30)
returns table (t timestamptz, dong text, activity text, label text, kind text, tree_name text, nickname text, is_me boolean)
language sql stable security definer
set search_path = public
as $$
  select date_trunc('minute', a.t), a.dong, a.activity, c.label, a.kind, f.tree_name,
         case when a.guardian_id = auth.uid() or coalesce(p.show_nickname, false) then g.nickname end,
         a.guardian_id = auth.uid()
    from public.activities a
    join public.activity_catalog c on c.id = a.activity
    join public.guardians g on g.id = a.guardian_id
    left join public.tree_follows f on f.guardian_id = a.guardian_id and f.tree_id = a.tree_id
    left join public.guardian_prefs p on p.guardian_id = a.guardian_id
   where a.t > now() - interval '7 days' and a.t <= now() + interval '5 minutes'
   order by a.t desc, a.id desc
   limit least(greatest(coalesce(p_limit, 30), 1), 50);
$$;

-- 지도: 화면 안 나무(관리번호 목록, 최대 3000개) 중 다른 보호자가 돌보는 나무. 누가 돌보는지는 돌려주지 않는다
create or replace function public.community_trees_in_view(p_ids text[])
returns table (tree_id text, guardians int, others int, last_day date, recent int, is_mine boolean)
language sql stable security definer
set search_path = public
as $$
  with ids as (
    select distinct u.id from unnest(coalesce(p_ids, '{}'::text[])) with ordinality as u(id, n) where u.n <= 3000
  )
  select f.tree_id,
         count(*)::int,
         count(*) filter (where f.guardian_id is distinct from auth.uid())::int,
         (select max((a.t at time zone 'Asia/Seoul')::date) from public.activities a where a.tree_id = f.tree_id and a.t <= now() + interval '5 minutes'),
         (select count(*)::int from public.activities a where a.tree_id = f.tree_id and a.t > now() - interval '30 days' and a.t <= now() + interval '5 minutes'),
         bool_or(f.guardian_id = auth.uid())
    from public.tree_follows f
   where f.tree_id in (select i.id from ids i)
   group by f.tree_id
  having count(*) filter (where f.guardian_id is distinct from auth.uid()) > 0;
$$;

-- 권한: 참여한 사람(authenticated)만 부를 수 있다. Supabase 기본 권한이 anon에게도 주므로 따로 거둔다
revoke all on function public.community_period_start(text) from public, anon;
revoke all on function public.community_prefs() from public, anon;
revoke all on function public.community_set_prefs(boolean) from public, anon;
revoke all on function public.community_rankings(text, text, int) from public, anon;
revoke all on function public.community_stats() from public, anon;
revoke all on function public.community_feed(int) from public, anon;
revoke all on function public.community_trees_in_view(text[]) from public, anon;
grant execute on function public.community_period_start(text) to authenticated;
grant execute on function public.community_prefs() to authenticated;
grant execute on function public.community_set_prefs(boolean) to authenticated;
grant execute on function public.community_rankings(text, text, int) to authenticated;
grant execute on function public.community_stats() to authenticated;
grant execute on function public.community_feed(int) to authenticated;
grant execute on function public.community_trees_in_view(text[]) to authenticated;
