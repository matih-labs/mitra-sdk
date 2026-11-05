"""``err.category`` is the ``category`` string the server sent, else ``None``. The table is shared with the
TypeScript SDK (sdks/error_category_cases.json, test/error_category.test.ts), so the two cannot drift."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from mitra import MitraError

CASES = json.loads((Path(__file__).resolve().parents[2] / "error_category_cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_error_category_is_the_servers_or_none(make_client, case):
    client = make_client(lambda request: httpx.Response(case["status"], content=case["body"]))
    with pytest.raises(MitraError) as caught:
        client.sources.list()
    assert caught.value.category == case["category"]


@pytest.mark.parametrize(
    ("raised", "category"),
    [(httpx.ConnectError("refused"), "network"), (httpx.ReadTimeout("slow"), "timeout")],
    ids=["a refused connection is network", "a timeout is timeout"],
)
def test_a_request_with_no_response_names_its_own_category(make_client, raised, category):
    def down(request: httpx.Request) -> httpx.Response:
        raise raised

    with pytest.raises(MitraError, match="network error") as caught:
        make_client(down).sources.list()
    assert (caught.value.status, caught.value.category) == (None, category)
