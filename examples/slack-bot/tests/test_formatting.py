import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from mitra import Answer, Dashboard, MitraError, RateLimitError  # noqa: E402

import formatting as f  # noqa: E402


def test_parse_command():
    assert f.parse_command("") == ("help", "")
    assert f.parse_command("ask how many orders") == ("ask", "how many orders")
    assert f.parse_command("GEMS") == ("gems", "")
    assert f.parse_command("dashboard Sales Overview") == ("dashboard", "Sales Overview")
    assert f.parse_command("how many orders today") == ("ask", "how many orders today")


def test_strip_mention():
    assert f.strip_mention("<@U123ABC> top products?") == "top products?"


def test_match_name():
    items = [Dashboard(id="1", title="Sales Overview"), Dashboard(id="2", title="Inventory")]
    assert f.match_name(items, "inventory").id == "2"
    assert f.match_name(items, "sales").id == "1"
    assert f.match_name(items, "sale overvew").id == "1"
    assert f.match_name(items, "zzzzzz") is None


def make_answer(**kw):
    base = {"status": "answered", "answer": "Total is 5.", "conversation_id": "c1",
            "result": {"columns": [{"name": "region"}, {"name": "sales"}],
                       "rows": [["North", 5], ["South", 3]], "row_count": 2},
            "follow_ups": ["By month?"]}
    base.update(kw)
    return Answer.model_validate(base)


def test_answer_blocks_with_table_and_followups():
    blocks = f.answer_blocks(make_answer())
    text = " ".join(str(b) for b in blocks)
    assert "Total is 5." in text and "North" in text and "By month?" in text


def test_clarification_becomes_buttons():
    answer = make_answer(status="clarification", answer=None,
                         clarification={"question": "Which year?", "options": ["2025", "2026"]})
    blocks = f.answer_blocks(answer)
    assert blocks[0]["text"]["text"] == "Which year?"
    assert [e["text"]["text"] for e in blocks[1]["elements"]] == ["2025", "2026"]


def test_empty_has_default_text():
    blocks = f.answer_blocks(make_answer(status="empty", answer=None, result=None))
    assert "No rows" in blocks[0]["text"]["text"]


def test_table_truncation_note():
    rows = [[str(i), i] for i in range(30)]
    answer = make_answer(result={"columns": [{"name": "a"}, {"name": "b"}], "rows": rows,
                                 "row_count": 30})
    assert "20 more rows" in f.format_table(answer.result)


def test_error_text():
    assert "7s" in f.error_text(RateLimitError("x", retry_after=7))
    assert "ref r1" in f.error_text(MitraError("boom", request_id="r1"))


def test_credit_errors_say_which_limit():
    from mitra import CreditsError

    assert "monthly credit cap" in f.error_text(CreditsError("x", category="member_cap"))
    assert "out of credits" in f.error_text(CreditsError("x", category="not_ready"))


def test_cancelled_has_default_text():
    blocks = f.answer_blocks(make_answer(status="cancelled", answer=None, result=None))
    assert "cancelled" in blocks[0]["text"]["text"]


def test_locale():
    assert f.slack_locale_to_language("hi_IN") == "hi-IN"
    assert f.slack_locale_to_language(None) is None
