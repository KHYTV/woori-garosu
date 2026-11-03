import re
from pathlib import Path

import pglast

SQL = Path(__file__).resolve().parents[1] / "supabase" / "user_trees.sql"


def test_user_trees_sql_parses_as_postgresql():
    sql = SQL.read_text(encoding="utf-8")
    kinds = [type(s.stmt).__name__ for s in pglast.parse_sql(sql)]
    assert kinds.count("CreateStmt") == 1               # user_trees
    assert kinds.count("CreateFunctionStmt") == 2       # 트리거 함수, 공개 읽기 함수
    assert kinds.count("CreateTrigStmt") == 1
    assert kinds.count("CreatePolicyStmt") == 4
    body = re.search(r"create or replace function public\.user_trees_guard.*?\$\$;", sql, re.S).group(0)
    assert pglast.parse_plpgsql(body)


def test_user_trees_privacy_rules():
    sql = SQL.read_text(encoding="utf-8")
    assert "enable row level security" in sql
    # 쓰기·직접 읽기는 자기 행만
    for name in ("user_trees_read_own", "user_trees_insert", "user_trees_update", "user_trees_delete"):
        assert re.search(rf"create policy {name} .*guardian_id = auth\.uid\(\)", sql)
    assert "revoke all on public.user_trees from anon" in sql
    # 공개 읽기 함수는 누가 올렸는지 돌려주지 않는다
    returns = re.search(r"returns table \((.*?)\)\n", sql).group(1)
    assert "guardian_id" not in returns
    # 사진·시각·정확도 열은 없다
    table = re.search(r"create table if not exists public\.user_trees \((.*?)\n\);", sql, re.S).group(1)
    for col in ("photo", "acc", "created_at", "nickname"):
        assert not re.search(rf"^\s+{col}\s", table, re.M)
    assert "round(new.lon::numeric, 5)" in sql      # 좌표 약 1m
    assert "new.verified := false" in sql           # 검증 표시는 관리자만


def test_sns_schema_unchanged_by_user_trees():
    sns = (SQL.parent / "sns_schema.sql").read_text(encoding="utf-8")
    assert "user_trees" not in sns
