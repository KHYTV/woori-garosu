"""나무 SNS(공동보호자·동네 순위)용 Supabase 스키마(SQL)를 config/activities.json에서 만든다.

  python -m pipeline.sns_sql              # supabase/sns_schema.sql 생성

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


def main() -> None:
    config = json.loads(ACT_JSON.read_text(encoding="utf-8"))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(build(config), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
