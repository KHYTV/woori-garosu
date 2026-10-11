import json
import re

import pglast

from pipeline import sns_sql


def _config():
    return json.loads(sns_sql.ACT_JSON.read_text(encoding="utf-8"))


def test_generated_schema_parses_as_postgresql():
    sql = sns_sql.build(_config())
    kinds = [type(s.stmt).__name__ for s in pglast.parse_sql(sql)]
    assert kinds.count("CreateStmt") == 5          # catalog, guardians, follows, activities, messages
    assert kinds.count("CreateFunctionStmt") == 3  # 트리거 함수 3개
    assert kinds.count("CreateTrigStmt") == 3
    assert kinds.count("ViewStmt") == 4
    for name in ("sns_guardian_guard", "sns_activity_guard", "sns_message_guard"):
        body = re.search(rf"create or replace function public\.{name}.*?\$\$;", sql, re.S).group(0)
        assert pglast.parse_plpgsql(body)


def test_catalog_and_guards_follow_config():
    config = _config()
    sql = sns_sql.build(config)
    for kind in ("care", "practice"):
        for a in config[kind]:
            assert f"('{a['id']}', '{kind}'," in sql
    assert f"if n >= {config['daily_limit_per_tree']} then" in sql
    assert "enable row level security" in sql
    assert "new.points := c.points" in sql            # 점수는 서버 목록에서
    assert "security_invoker = on" in sql


def test_schema_file_is_up_to_date():
    assert sns_sql.OUT.read_text(encoding="utf-8") == sns_sql.build(_config())
