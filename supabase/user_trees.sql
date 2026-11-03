-- 우리동네가로수: 시민이 직접 등록한 나무의 온라인 공유(선택)
-- sns_schema.sql을 먼저 실행한 같은 Supabase 프로젝트에서, 대시보드 → SQL Editor에 붙여 넣고 실행한다. 다시 실행해도 안전하다.
-- 이 파일이 없거나 실행 전이면 앱은 등록 나무를 기기에만 저장한다(docs/js/cloud.js userTreesApi.available()).
--
-- 공개 범위
--   * 올라가는 것: 등록 번호(u-...), 수종, 수종 출처(user/ai/unknown), 흉고(cm), 좌표(소수 5자리 ≈ 1m), 행정동, 등록 날짜(시각 없음), 검증 여부
--   * 올라가지 않는 것: 사진(기존 원칙대로 사진은 서버에 두지 않음), 닉네임, 등록 시각, GPS 정확도
--   * 공개 지도는 user_trees_in_bbox() 함수로만 읽는다. 이 함수는 누가 등록했는지(guardian_id)를 돌려주지 않는다.
--     표 자체는 자기 행만 읽을 수 있어서, 닉네임과 등록 위치를 이어 붙여 '어디 사는 사람인지' 추적하기 어렵게 한다.
--   * 앱은 공유 전에 "위치가 누구나 보는 지도에 올라가요" 동의를 받고(기본 꺼짐), 사유지 나무는 올리지 말라고 안내한다.

create table if not exists public.user_trees (
  id             text primary key check (id ~ '^u-[0-9a-z]{4,14}-[0-9a-z]{4}$'),
  guardian_id    uuid not null default auth.uid() references public.guardians (id) on delete cascade,
  species        text check (species is null or char_length(species) <= 20),
  species_source text not null default 'unknown' check (species_source in ('user', 'ai', 'unknown')),
  dbh            numeric(5,1) check (dbh is null or dbh between 1 and 300),
  lon            double precision not null check (lon between 126.95 and 127.35),   -- 전주 범위
  lat            double precision not null check (lat between 35.70 and 35.95),
  dong           text check (dong is null or char_length(dong) <= 40),
  verified       boolean not null default false,
  created_on     date not null default (now() at time zone 'Asia/Seoul')::date,
  updated_at     timestamptz not null default now()
);
create index if not exists user_trees_lonlat_idx on public.user_trees (lon, lat);
create index if not exists user_trees_guardian_idx on public.user_trees (guardian_id);

-- 트리거: 주인은 본인으로 고정, 검증 표시는 대시보드(관리자)만, 좌표는 약 1m로 반올림, 하루 20그루까지
create or replace function public.user_trees_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then
    return new;  -- 대시보드·서비스 키(관리자)는 그대로 둔다
  end if;
  new.guardian_id := auth.uid();
  new.lon := round(new.lon::numeric, 5)::double precision;
  new.lat := round(new.lat::numeric, 5)::double precision;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.verified := false;
    new.created_on := (now() at time zone 'Asia/Seoul')::date;
    select count(*) into n from public.user_trees
      where guardian_id = auth.uid() and created_on = (now() at time zone 'Asia/Seoul')::date;
    if n >= 20 then
      raise exception '오늘은 더 등록할 수 없어요(하루 20그루)' using errcode = 'P0001';
    end if;
  else
    new.verified := old.verified;
    new.created_on := old.created_on;
  end if;
  return new;
end $$;
drop trigger if exists user_trees_guard on public.user_trees;
create trigger user_trees_guard before insert or update on public.user_trees
  for each row execute function public.user_trees_guard();

-- RLS: 쓰기는 자기 행만, 표 직접 읽기도 자기 행만(공개 읽기는 아래 함수로)
alter table public.user_trees enable row level security;
drop policy if exists user_trees_read_own on public.user_trees;
create policy user_trees_read_own on public.user_trees for select to authenticated using (guardian_id = auth.uid());
drop policy if exists user_trees_insert on public.user_trees;
create policy user_trees_insert on public.user_trees for insert to authenticated with check (guardian_id = auth.uid());
drop policy if exists user_trees_update on public.user_trees;
create policy user_trees_update on public.user_trees for update to authenticated using (guardian_id = auth.uid()) with check (guardian_id = auth.uid());
drop policy if exists user_trees_delete on public.user_trees;
create policy user_trees_delete on public.user_trees for delete to authenticated using (guardian_id = auth.uid());
revoke all on public.user_trees from anon;
grant select, insert, update, delete on public.user_trees to authenticated;

-- 모두 읽기: 지도 범위 안의 공유 나무(누가 올렸는지는 빼고). 참여하지 않은 사람(anon)도 부를 수 있다
create or replace function public.user_trees_in_bbox(w double precision, s double precision, e double precision, n double precision, max_rows int default 500)
returns table (id text, species text, species_source text, dbh numeric, lon double precision, lat double precision, dong text, verified boolean, created_on date)
language sql stable security definer set search_path = public as $$
  select t.id, t.species, t.species_source, t.dbh, t.lon, t.lat, t.dong, t.verified, t.created_on
  from public.user_trees t
  where t.lon between w and e and t.lat between s and n
  order by t.created_on desc
  limit least(greatest(coalesce(max_rows, 500), 1), 1000);
$$;
revoke all on function public.user_trees_in_bbox(double precision, double precision, double precision, double precision, int) from public;
grant execute on function public.user_trees_in_bbox(double precision, double precision, double precision, double precision, int) to anon, authenticated;
