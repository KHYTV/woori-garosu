"""연구4 실험 응답을 받는 Supabase 스키마(SQL)를 docs/study/study.json에서 만든다.

  python -m pipeline.study_sql            # supabase/study_schema.sql 생성

Supabase 대시보드 → SQL Editor에 파일 내용을 붙여 넣고 실행하면 된다. 여러 번 실행해도 안전하다.

보안 설계
- 응답 표는 행 수준 보안(RLS)을 켜고 정책을 두지 않아, 공개 키로는 직접 읽기·쓰기가 안 된다.
- 참가자 화면은 submit_study_record 함수만 부른다. 같은 참여 번호의 응답을 갱신하되, 완료된 응답은 덮어쓰지 않는다.
- 연구자 화면은 study_counts 함수로 조건별 집계만 본다(개별 응답은 노출하지 않음).
- 원자료는 대시보드에서 study_responses_flat(문항별 열로 펼친 보기)을 내보낸다.
"""

import json
import re

from .schema import ROOT

STUDY_JSON = ROOT / "docs" / "study" / "study.json"
OUT = ROOT / "supabase" / "study_schema.sql"
SAFE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")


def build(config: dict) -> str:
    conditions = config["conditions"]
    prefix = config["study_id"].split("-")[0]
    for c in conditions:
        assert SAFE.match(c), c
    assert SAFE.match(prefix), prefix
    cond_list = ", ".join(f"'{c}'" for c in conditions)

    cols = []
    for s in config["sections"]:
        for it in s["items"]:
            iid = it["id"]
            assert SAFE.match(iid), iid
            if s["kind"] == "likert":
                cols.append(f"  (r.record->'answers'->>'{iid}')::int as {iid}")
            else:
                cols.append(f"  r.record->'answers'->>'{iid}' as {iid}")
                if s["kind"] == "recall":
                    cols.append(f"  (r.record->'recall_ok'->>'{iid}_ok')::boolean as {iid}_ok")
    answer_cols = ",\n".join(cols)

    return f"""-- 우리동네가로수 연구4 실험 응답 저장소 (pipeline/study_sql.py가 study.json에서 생성)
-- Supabase 대시보드 → SQL Editor에 붙여 넣고 실행한다. 다시 실행해도 안전하다.

create table if not exists public.study_responses (
  pid          text primary key check (pid ~ '^[A-Z2-9]{{8}}$'),
  study_id     text not null check (char_length(study_id) <= 64),
  condition    text not null check (condition in ({cond_list})),
  status       text not null check (char_length(status) <= 32),
  record       jsonb not null check (octet_length(record::text) <= 65536),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- 정책을 두지 않으므로 공개 키(anon·publishable)로는 표를 직접 읽거나 쓸 수 없다
alter table public.study_responses enable row level security;
revoke all on table public.study_responses from anon, authenticated;

-- 참가자 화면이 부르는 유일한 쓰기 경로
create or replace function public.submit_study_record(p_pid text, p_record jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := coalesce(p_record->>'status', 'started');
begin
  if p_pid is null or p_pid !~ '^[A-Z2-9]{{8}}$' then
    raise exception 'invalid pid';
  end if;
  if (p_record->>'pid') is distinct from p_pid then
    raise exception 'pid mismatch';
  end if;
  if coalesce(p_record->>'study_id', '') !~ '^{prefix}-' then
    raise exception 'unknown study';
  end if;
  insert into public.study_responses as r (pid, study_id, condition, status, record, completed_at)
  values (p_pid, p_record->>'study_id', p_record->>'condition', v_status, p_record,
          case when v_status = 'complete' then now() end)
  on conflict (pid) do update
    set record = excluded.record,
        status = excluded.status,
        updated_at = now(),
        completed_at = coalesce(r.completed_at, excluded.completed_at)
    where r.status <> 'complete';  -- 완료된 응답은 덮어쓰지 않는다
  return 'ok';
end;
$$;
revoke all on function public.submit_study_record(text, jsonb) from public;
grant execute on function public.submit_study_record(text, jsonb) to anon, authenticated;

-- 연구자 화면용 집계(개별 응답은 돌려주지 않는다)
create or replace function public.study_counts(p_study_id text)
returns table (condition text, status text, n bigint, attention_ok bigint, avg_exposure_sec numeric)
language sql
stable
security definer
set search_path = public
as $$
  select r.condition,
         case when r.status in ('complete', 'handoff') then r.status else 'in_progress' end as status,
         count(*) as n,
         count(*) filter (where (r.record->>'attention_ok')::boolean) as attention_ok,
         round(avg((r.record->>'stimulus_ms')::numeric) / 1000, 1) as avg_exposure_sec
  from public.study_responses r
  where r.study_id = p_study_id
  group by 1, 2
  order by 1, 2;
$$;
revoke all on function public.study_counts(text) from public;
grant execute on function public.study_counts(text) to anon, authenticated;

-- 연구자용 내보내기 보기: 대시보드(Table Editor 또는 SQL Editor)에서 CSV로 내려받는다
create or replace view public.study_responses_flat
with (security_invoker = true)
as
select
  r.pid, r.study_id, r.condition, r.status, r.created_at, r.updated_at, r.completed_at,
  r.record->>'assignment' as assignment,
  r.record->>'session' as session,
  r.record->>'tree_id' as tree_id,
  (r.record->>'min_exposure_sec')::int as min_exposure_sec,
  (r.record->>'stimulus_ms')::int as stimulus_ms,
  (r.record->'interactions'->>'n_rotate')::int as n_rotate,
  (r.record->'interactions'->>'n_season_change')::int as n_season_change,
  r.record->'interactions'->'seasons_viewed' as seasons_viewed,
  (r.record->'interactions'->>'n_year_change')::int as n_year_change,
  (r.record->'interactions'->>'max_years')::int as max_years,
  (r.record->>'attention_ok')::boolean as attention_ok,
  (r.record->>'recall_score')::int as recall_score,
  (r.record->>'device_w')::int as device_w,
  (r.record->>'device_h')::int as device_h,
  (r.record->>'touch')::boolean as touch,
{answer_cols}
from public.study_responses r;
revoke all on table public.study_responses_flat from anon, authenticated;
"""


def main() -> None:
    config = json.loads(STUDY_JSON.read_text(encoding="utf-8"))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build(config), encoding="utf-8")
    print(f"{OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
