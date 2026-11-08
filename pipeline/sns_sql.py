"""나무 SNS(공동보호자·동네 순위)용 Supabase 스키마(SQL)를 config/activities.json에서 만든다.

  python -m pipeline.sns_sql              # supabase/sns_schema.sql, supabase/community.sql 생성

Supabase 대시보드 → SQL Editor에 붙여 넣고 실행한다. 여러 번 실행해도 안전하다.
먼저 Authentication → Sign In / Providers → Anonymous sign-ins 를 켜야 한다(기기마다 익명 계정을 만들어 쓴다).

보안 설계
- 모든 표는 RLS를 켜고, 로그인한(익명 포함) 사용자가 자기 행만 쓰도록 정책을 둔다. 공개 키만으로는 아무것도 못 쓴다.
- 점수·감축량은 클라이언트가 보내는 값을 믿지 않고 activity_catalog에서 트리거가 채운다.
- 하루 기록 한도(나무·활동당), 메시지 횟수 한도는 트리거가 막는다.
- 사진·메모·위치는 서버로 보내지 않는다(활동 종류·시각·나무·동만 올라간다).
"""

import json
import re

from .schema import CONFIG_DIR, ROOT

ACT_JSON = CONFIG_DIR / "activities.json"
OUT = ROOT / "supabase" / "sns_schema.sql"
SAFE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


def _sql_str(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def build(config: dict) -> str:
    rows = []
    for kind in ("care", "practice"):
        for a in config[kind]:
            assert SAFE.match(a["id"]), a["id"]
            kg = "null" if a.get("kg") is None else f"{float(a['kg']):.4f}"
            rows.append(f"  ({_sql_str(a['id'])}, '{kind}', {_sql_str(a['label'])}, {int(a['points'])}, {kg})")
    catalog_rows = ",\n".join(rows)
    daily_limit = int(config.get("daily_limit_per_tree", 3))

    return f"""-- 우리동네가로수 나무 SNS 저장소 (pipeline/sns_sql.py가 config/activities.json에서 생성)
-- Supabase 대시보드 → SQL Editor에 붙여 넣고 실행한다. 다시 실행해도 안전하다.
-- 먼저 Authentication → Sign In / Providers 에서 Anonymous sign-ins 를 켠다.

-- 활동 목록: 점수와 감축 환산 계수의 서버 쪽 원본
create table if not exists public.activity_catalog (
  id     text primary key check (id ~ '^[a-z_]{{1,32}}$'),
  kind   text not null check (kind in ('care', 'practice')),
  label  text not null check (char_length(label) <= 40),
  points int  not null check (points between 0 and 1000),
  kg     numeric(10,4) check (kg is null or kg >= 0)
);
insert into public.activity_catalog (id, kind, label, points, kg) values
{catalog_rows}
on conflict (id) do update set kind = excluded.kind, label = excluded.label, points = excluded.points, kg = excluded.kg;

-- 보호자(기기마다 하나의 익명 계정)
create table if not exists public.guardians (
  id         uuid primary key references auth.users (id) on delete cascade,
  nickname   text not null check (char_length(nickname) between 1 and 12),
  dong       text check (dong is null or char_length(dong) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 내 나무(친구 맺기)
create table if not exists public.tree_follows (
  guardian_id uuid not null references public.guardians (id) on delete cascade,
  tree_id     text not null check (tree_id ~ '^[0-9A-Za-z_-]{{1,32}}$'),
  tree_name   text not null check (char_length(tree_name) between 1 and 12),
  species     text check (species is null or char_length(species) <= 20),
  dong        text check (dong is null or char_length(dong) <= 40),
  since       timestamptz not null default now(),
  primary key (guardian_id, tree_id)
);
create index if not exists tree_follows_tree_idx on public.tree_follows (tree_id);

-- 활동 기록(돌봄·생활 실천). 사진·메모는 올리지 않는다
create table if not exists public.activities (
  id          bigint generated always as identity primary key,
  guardian_id uuid not null references public.guardians (id) on delete cascade,
  tree_id     text not null check (tree_id ~ '^[0-9A-Za-z_-]{{1,32}}$'),
  dong        text check (dong is null or char_length(dong) <= 40),
  activity    text not null references public.activity_catalog (id),
  kind        text not null,
  points      int  not null,
  kg          numeric(10,4),
  client_id   text not null check (char_length(client_id) between 1 and 64),
  t           timestamptz not null default now(),
  unique (guardian_id, client_id)
);
create index if not exists activities_tree_idx on public.activities (tree_id, t desc);
create index if not exists activities_dong_idx on public.activities (dong, t desc);

-- 공동보호자 대화(나무마다 한 방)
create table if not exists public.tree_messages (
  id          bigint generated always as identity primary key,
  tree_id     text not null check (tree_id ~ '^[0-9A-Za-z_-]{{1,32}}$'),
  guardian_id uuid not null references public.guardians (id) on delete cascade,
  nickname    text not null,
  body        text not null check (char_length(body) between 1 and 500),
  t           timestamptz not null default now()
);
create index if not exists tree_messages_tree_idx on public.tree_messages (tree_id, id);

-- 트리거: 보호자 행은 본인 것만, 갱신 시각
create or replace function public.sns_guardian_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from auth.uid() then
    raise exception 'guardian id must be the signed-in user';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists guardians_guard on public.guardians;
create trigger guardians_guard before insert or update on public.guardians
  for each row execute function public.sns_guardian_guard();

-- 트리거: 활동은 점수·감축량을 목록에서 채우고, 친구 맺은 나무만, 하루 {daily_limit}번까지
create or replace function public.sns_activity_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.activity_catalog%rowtype;
  n int;
begin
  new.guardian_id := auth.uid();
  if new.guardian_id is null then
    raise exception 'sign in first';
  end if;
  select * into c from public.activity_catalog where id = new.activity;
  if not found then
    raise exception 'unknown activity';
  end if;
  if not exists (select 1 from public.tree_follows f where f.guardian_id = new.guardian_id and f.tree_id = new.tree_id) then
    raise exception 'not a guardian of this tree';
  end if;
  new.kind := c.kind;
  new.points := c.points;
  new.kg := c.kg;
  if new.dong is null then
    select f.dong into new.dong from public.tree_follows f where f.guardian_id = new.guardian_id and f.tree_id = new.tree_id;
  end if;
  if new.t is null or new.t > now() + interval '5 minutes' then
    new.t := now();
  end if;
  select count(*) into n from public.activities a
   where a.guardian_id = new.guardian_id and a.tree_id = new.tree_id and a.activity = new.activity
     and (a.t at time zone 'Asia/Seoul')::date = (new.t at time zone 'Asia/Seoul')::date;
  if n >= {daily_limit} then
    raise exception 'daily limit reached';
  end if;
  return new;
end;
$$;
drop trigger if exists activities_guard on public.activities;
create trigger activities_guard before insert on public.activities
  for each row execute function public.sns_activity_guard();

-- 트리거: 메시지는 친구 맺은 나무의 방에만, 10분에 30개까지, 닉네임은 보호자 표에서
create or replace function public.sns_message_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  new.guardian_id := auth.uid();
  if new.guardian_id is null then
    raise exception 'sign in first';
  end if;
  if not exists (select 1 from public.tree_follows f where f.guardian_id = new.guardian_id and f.tree_id = new.tree_id) then
    raise exception 'not a guardian of this tree';
  end if;
  select g.nickname into new.nickname from public.guardians g where g.id = new.guardian_id;
  if new.nickname is null then
    raise exception 'set a nickname first';
  end if;
  new.t := now();
  select count(*) into n from public.tree_messages m where m.guardian_id = new.guardian_id and m.t > now() - interval '10 minutes';
  if n >= 30 then
    raise exception 'too many messages';
  end if;
  return new;
end;
$$;
drop trigger if exists tree_messages_guard on public.tree_messages;
create trigger tree_messages_guard before insert on public.tree_messages
  for each row execute function public.sns_message_guard();

-- 행 수준 보안: 로그인한(익명 포함) 사용자만, 쓰기는 자기 행만
alter table public.activity_catalog enable row level security;
alter table public.guardians        enable row level security;
alter table public.tree_follows     enable row level security;
alter table public.activities       enable row level security;
alter table public.tree_messages    enable row level security;

drop policy if exists catalog_read on public.activity_catalog;
create policy catalog_read on public.activity_catalog for select to anon, authenticated using (true);

drop policy if exists guardians_read on public.guardians;
create policy guardians_read on public.guardians for select to authenticated using (true);
drop policy if exists guardians_insert on public.guardians;
create policy guardians_insert on public.guardians for insert to authenticated with check (id = auth.uid());
drop policy if exists guardians_update on public.guardians;
create policy guardians_update on public.guardians for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists follows_read on public.tree_follows;
create policy follows_read on public.tree_follows for select to authenticated using (true);
drop policy if exists follows_write on public.tree_follows;
create policy follows_write on public.tree_follows for insert to authenticated with check (guardian_id = auth.uid());
drop policy if exists follows_update on public.tree_follows;
create policy follows_update on public.tree_follows for update to authenticated using (guardian_id = auth.uid()) with check (guardian_id = auth.uid());
drop policy if exists follows_delete on public.tree_follows;
create policy follows_delete on public.tree_follows for delete to authenticated using (guardian_id = auth.uid());

drop policy if exists activities_read on public.activities;
create policy activities_read on public.activities for select to authenticated using (true);
drop policy if exists activities_insert on public.activities;
create policy activities_insert on public.activities for insert to authenticated with check (true);

drop policy if exists messages_read on public.tree_messages;
create policy messages_read on public.tree_messages for select to authenticated
  using (exists (select 1 from public.tree_follows f where f.guardian_id = auth.uid() and f.tree_id = tree_messages.tree_id));
drop policy if exists messages_insert on public.tree_messages;
create policy messages_insert on public.tree_messages for insert to authenticated with check (true);

grant usage on schema public to anon, authenticated;
grant select on public.activity_catalog to anon, authenticated;
grant select, insert, update on public.guardians to authenticated;
grant select, insert, update, delete on public.tree_follows to authenticated;
grant select, insert on public.activities to authenticated;
grant select, insert on public.tree_messages to authenticated;
grant usage on all sequences in schema public to authenticated;

-- 보기: 나무별 공동보호자
create or replace view public.tree_guardians with (security_invoker = on) as
select f.tree_id, f.guardian_id, g.nickname, f.tree_name, f.since
  from public.tree_follows f join public.guardians g on g.id = f.guardian_id;

-- 보기: 나무별 최근 활동(공동보호자 피드)
create or replace view public.tree_activity_feed with (security_invoker = on) as
select a.id, a.tree_id, g.nickname, a.activity, c.label, a.kind, a.points, a.kg, a.t
  from public.activities a
  join public.guardians g on g.id = a.guardian_id
  join public.activity_catalog c on c.id = a.activity;

-- 보기: 보호자별 점수
create or replace view public.guardian_scores with (security_invoker = on) as
select g.id as guardian_id, g.nickname, g.dong,
       coalesce(sum(a.points), 0)::int as points,
       coalesce(sum(a.kg), 0)::numeric(12,3) as kg,
       count(a.id)::int as activities,
       (select count(*) from public.tree_follows f where f.guardian_id = g.id)::int as trees
  from public.guardians g left join public.activities a on a.guardian_id = g.id
 group by g.id, g.nickname, g.dong;

-- 보기: 동네 순위(최근 30일)
create or replace view public.dong_rankings with (security_invoker = on) as
select dong,
       rank() over (order by sum(points) desc, count(distinct guardian_id) desc) as rank,
       count(distinct guardian_id)::int as guardians,
       count(distinct tree_id)::int as trees,
       count(*)::int as activities,
       sum(points)::int as points,
       coalesce(sum(kg), 0)::numeric(12,3) as kg
  from public.activities
 where dong is not null and t > now() - interval '30 days'
 group by dong;

grant select on public.tree_guardians, public.tree_activity_feed, public.guardian_scores, public.dong_rankings to authenticated;
"""


# ---------- 커뮤니티(선택): 기간별 순위·현황 숫자·이웃 소식·다른 보호자가 돌보는 나무 ----------
# sns_schema.sql 뒤에 따로 실행하는 파일. 위 표·보기·정책은 건드리지 않고, 새 표 1개(guardian_prefs)와
# security definer 함수만 더한다. 함수는 집계·최소 필드만 돌려주고 개수·기간을 묶는다.
COMMUNITY_OUT = ROOT / "supabase" / "community.sql"
PERIODS = ("day", "week", "month", "year")   # 한국 시간 기준 오늘·이번 주(월요일부터)·이번 달·올해
RANK_LIMIT = 50                                # 순위 최대 줄 수(+ 내 줄)
FEED_LIMIT = 50                                # 이웃 소식 최대 건수
FEED_DAYS = 7                                  # 이웃 소식은 최근 7일만
IDS_LIMIT = 3000                               # 지도: 한 번에 물을 수 있는 나무 수
RECENT_DAYS = 30                               # 지도 카드의 '최근 활동 n회' 기간


def build_community() -> str:
    periods = ", ".join(_sql_str(p) for p in PERIODS)
    return f"""-- 우리동네가로수 커뮤니티: 기간별 순위·현황 숫자·이웃 소식·다른 보호자가 돌보는 나무 (pipeline/sns_sql.py가 생성)
-- sns_schema.sql을 먼저 실행한 같은 Supabase 프로젝트에서, 대시보드 → SQL Editor에 붙여 넣고 실행한다. 다시 실행해도 안전하다.
-- 이 파일을 실행하기 전에는 앱이 함수가 없는 것(404)을 한 번 보고 조용히 예전 '동네 순위(30일)'만 보여 준다.
-- sns_schema.sql의 표·보기·정책은 바꾸지 않는다. 새 표 guardian_prefs 하나와 함수만 더한다.
--
-- 공개 범위(온라인에 참여한 사람끼리만: 함수는 authenticated에게만 열고 anon에게는 닫는다)
--   * 보이는 것: 동 이름, 활동 종류·시각(분 단위), 나무 관리번호·이름·수종, 점수·감축(추정)량 집계,
--     닉네임은 '순위·소식에 닉네임 보이기'를 켠 사람만(기본 꺼짐 → '익명 보호자'). 본인 줄은 본인에게만 닉네임이 보인다.
--   * 보이지 않는 것: 사진·메모·위치(원래 서버에 없다), 보호자 id, 닉네임을 끈 사람의 닉네임·동.
--   * 이웃 소식(community_feed)은 최근 {FEED_DAYS}일·최대 {FEED_LIMIT}건이고 나무 관리번호를 돌려주지 않는다(소식 → 나무 위치 → 그 시각 그 자리의 사람으로 이어지지 않게).
--   * 지도(community_trees_in_view)는 보호자 수·마지막 활동 날짜(시각 없음)·최근 {RECENT_DAYS}일 활동 수만 돌려주고 이름·닉네임은 주지 않는다.
--     서버에는 나무 좌표가 없어서, 앱이 지도 화면 범위 안 나무의 관리번호(최대 {IDS_LIMIT}개)를 보내 묻는다.
--   * 순위는 최대 {RANK_LIMIT}줄 + 내 줄. 기간은 한국 시간으로 오늘·이번 주(월요일부터)·이번 달·올해.

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
  select case when p_period in ({periods})
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

-- 기간별 순위: p_target = 'dong'(동네) | 'guardian'(보호자) | 'tree'(나무). 상위 p_limit줄(최대 {RANK_LIMIT}) + 내 줄
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
   where r.rnk <= least(greatest(coalesce(p_limit, 20), 1), {RANK_LIMIT}) or r.mine
   order by r.rnk, r.nm
   limit {RANK_LIMIT + 10};
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

-- 이웃 소식: 최근 {FEED_DAYS}일 활동, 최대 {FEED_LIMIT}건. 사진·메모·위치·나무 관리번호 없음, 시각은 분 단위
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
   where a.t > now() - interval '{FEED_DAYS} days' and a.t <= now() + interval '5 minutes'
   order by a.t desc, a.id desc
   limit least(greatest(coalesce(p_limit, 30), 1), {FEED_LIMIT});
$$;

-- 지도: 화면 안 나무(관리번호 목록, 최대 {IDS_LIMIT}개) 중 다른 보호자가 돌보는 나무. 누가 돌보는지는 돌려주지 않는다
create or replace function public.community_trees_in_view(p_ids text[])
returns table (tree_id text, guardians int, others int, last_day date, recent int, is_mine boolean)
language sql stable security definer
set search_path = public
as $$
  with ids as (
    select distinct u.id from unnest(coalesce(p_ids, '{{}}'::text[])) with ordinality as u(id, n) where u.n <= {IDS_LIMIT}
  )
  select f.tree_id,
         count(*)::int,
         count(*) filter (where f.guardian_id is distinct from auth.uid())::int,
         (select max((a.t at time zone 'Asia/Seoul')::date) from public.activities a where a.tree_id = f.tree_id and a.t <= now() + interval '5 minutes'),
         (select count(*)::int from public.activities a where a.tree_id = f.tree_id and a.t > now() - interval '{RECENT_DAYS} days' and a.t <= now() + interval '5 minutes'),
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
"""


def main() -> None:
    config = json.loads(ACT_JSON.read_text(encoding="utf-8"))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(build(config), encoding="utf-8")
    print(f"wrote {OUT}")
    COMMUNITY_OUT.write_text(build_community(), encoding="utf-8")
    print(f"wrote {COMMUNITY_OUT}")


if __name__ == "__main__":
    main()
