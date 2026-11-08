import re

import pglast

from pipeline import sns_sql


def _functions(sql):
    return {m.group(1): m.group(0) for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\$\$;", sql, re.S)}


def test_community_sql_parses_as_postgresql():
    sql = sns_sql.build_community()
    kinds = [type(s.stmt).__name__ for s in pglast.parse_sql(sql)]
    assert kinds.count("CreateStmt") == 1               # guardian_prefs
    assert kinds.count("CreateFunctionStmt") == 7
    assert kinds.count("ViewStmt") == 0
    fns = _functions(sql)
    assert set(fns) == {"community_period_start", "community_prefs", "community_set_prefs", "community_rankings",
                        "community_stats", "community_feed", "community_trees_in_view"}
    for name, text in fns.items():
        body = re.search(r"as \$\$\n(.*?)\$\$;", text, re.S).group(1)
        if "language plpgsql" in text:
            assert pglast.parse_plpgsql(text)
        else:
            assert pglast.parse_sql(body), name    # SQL 함수 본문도 문법 검사


def test_community_functions_are_definer_and_only_for_participants():
    sql = sns_sql.build_community()
    for name, text in _functions(sql).items():
        assert "set search_path = public" in text, name
        if name != "community_period_start":
            assert "security definer" in text, name
        sig = re.search(rf"grant execute on function public\.{name}\((.*?)\) to authenticated;", sql)
        assert sig, name
        assert f"revoke all on function public.{name}({sig.group(1)}) from public, anon;" in sql
    assert "to anon" not in sql
    assert "revoke all on public.guardian_prefs from anon, authenticated" in sql
    assert "create policy" not in sql                   # 선택 표는 함수로만 다룬다


def test_community_returns_minimal_fields_with_limits():
    sql = sns_sql.build_community()
    fns = _functions(sql)
    returns = {n: {c.split()[0] for c in re.search(r"returns table \((.*?)\)\n", t).group(1).split(",")}
               for n, t in fns.items() if "returns table" in t}
    assert set(returns) == {"community_rankings", "community_stats", "community_feed", "community_trees_in_view"}
    for name, cols in returns.items():
        assert not cols & {"guardian_id", "photo", "text", "body", "memo", "lon", "lat", "client_id", "id"}, name
    # 소식은 나무 관리번호를 주지 않는다(소식 → 나무 위치로 이어지지 않게)
    assert "tree_id" not in returns["community_feed"]
    # 지도는 이름·닉네임·시각을 주지 않는다(날짜만)
    assert returns["community_trees_in_view"] == {"tree_id", "guardians", "others", "last_day", "recent", "is_mine"}
    # 닉네임은 본인 또는 공개를 켠 사람만
    assert fns["community_feed"].count("coalesce(p.show_nickname, false) then g.nickname") == 1
    assert "where g.id = auth.uid() or coalesce(p.show_nickname, false)" in fns["community_rankings"]
    assert "show_nickname boolean not null default false" in sql
    # 개수·기간 제한
    assert f"least(greatest(coalesce(p_limit, 30), 1), {sns_sql.FEED_LIMIT})" in fns["community_feed"]
    assert f"interval '{sns_sql.FEED_DAYS} days'" in fns["community_feed"]
    assert f"least(greatest(coalesce(p_limit, 20), 1), {sns_sql.RANK_LIMIT})" in fns["community_rankings"]
    assert f"u.n <= {sns_sql.IDS_LIMIT}" in fns["community_trees_in_view"]
    assert "date_trunc('minute', a.t)" in fns["community_feed"]
    # 기간은 한국 시간 기준
    assert "now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'" in fns["community_period_start"]


def test_community_does_not_touch_sns_schema():
    sql = sns_sql.build_community()
    for stmt in pglast.parse_sql(sql):
        s = stmt.stmt
        if type(s).__name__ in ("AlterTableStmt", "CreatePolicyStmt", "DropStmt", "ViewStmt"):
            rel = getattr(s, "relation", None) or getattr(s, "table", None)
            assert rel is None or rel.relname == "guardian_prefs", rel.relname
    assert "community" not in sns_sql.OUT.read_text(encoding="utf-8")


def test_community_file_is_up_to_date():
    assert sns_sql.COMMUNITY_OUT.read_text(encoding="utf-8") == sns_sql.build_community()
