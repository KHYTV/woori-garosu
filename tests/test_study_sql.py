import json
import re

import pglast

from pipeline import study_sql


def _config():
    return json.loads(study_sql.STUDY_JSON.read_text(encoding="utf-8"))


def test_generated_schema_parses_as_postgresql():
    sql = study_sql.build(_config())
    kinds = [type(s.stmt).__name__ for s in pglast.parse_sql(sql)]
    assert kinds.count("CreateFunctionStmt") == 2
    assert "CreateStmt" in kinds and "ViewStmt" in kinds
    body = re.search(r"create or replace function public.submit_study_record.*?\$\$;", sql, re.S).group(0)
    assert pglast.parse_plpgsql(body)  # 함수 본문(PL/pgSQL)도 문법이 맞아야 한다


def test_flat_view_has_every_item_and_hides_tables_from_public_keys():
    config = _config()
    sql = study_sql.build(config)
    for section in config["sections"]:
        for item in section["items"]:
            assert f" as {item['id']}" in sql
    assert "enable row level security" in sql
    assert "revoke all on table public.study_responses from anon, authenticated" in sql
    assert "revoke all on table public.study_responses_flat from anon, authenticated" in sql
    assert "where r.status <> 'complete'" in sql  # 완료된 응답은 덮어쓰지 않는다


def test_schema_file_is_up_to_date():
    assert study_sql.OUT.read_text(encoding="utf-8") == study_sql.build(_config())
