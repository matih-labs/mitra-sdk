"""embeds.create / list / revoke on both clients, against docs/EMBEDS.md section 3.1 of
matih-labs/mitra (branch feat/embeds): mint request and response, and the 422 and 404 refusals."""

from __future__ import annotations

import httpx
import pytest
from conftest import body_of, json_response

from mitra import (
    EMBED_REFUSAL_CODES,
    AuthError,
    Embed,
    EmbedNotFoundError,
    EmbedRefusedError,
    MitraError,
    PermissionDeniedError,
    RateLimitError,
    embed_src,
)

TOKEN = "met_secretsecretsecret"
URL = "https://workspace.matih.ai/embed/dashboards/d_123?e=emt_Ab12#token=" + TOKEN
MINTED = {
    "id": "emt_Ab12",
    "token": TOKEN,
    "expires_at": "2026-10-31T10:05:00Z",
    "url": URL,
    "resource": {"type": "dashboard", "id": "d_123"},
    "origins": ["https://app.customer.com"],
}


def refusal(code: str, message: str = "refused", status: int = 422):
    return {"detail": {"category": "validation", "message": message, "code": code}}


def recorder(payload=None, status=200):
    seen: dict = {"requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["requests"].append(request)
        if status == 204:
            return httpx.Response(204)
        return json_response(payload if payload is not None else {}, status)

    handler.seen = seen
    return handler


def test_create_sends_the_contract_body_and_parses_the_response(make_client):
    h = recorder(MINTED, 201)
    embed = make_client(h).embeds.create(
        resource={"type": "dashboard", "id": "d_123"},
        filters={"customer_id": "C123"},
        origins=["https://app.customer.com"],
        ttl_seconds=300,
    )
    request = h.seen["requests"][0]
    assert request.method == "POST"
    assert str(request.url) == "https://workspace.matih.ai/api/v1/embeds"
    assert request.headers["authorization"] == "Bearer mtk_test"
    assert body_of(request) == {
        "resource": {"type": "dashboard", "id": "d_123"},
        "filters": {"customer_id": "C123"},
        "origins": ["https://app.customer.com"],
        "ttl_seconds": 300,
    }
    assert isinstance(embed, Embed)
    assert embed.id == "emt_Ab12" and embed.token == TOKEN
    assert embed.expires_at == "2026-10-31T10:05:00Z"
    assert embed.resource.type == "dashboard" and embed.resource.id == "d_123"
    assert embed.origins == ["https://app.customer.com"]


def test_create_is_not_idempotent_so_it_sends_no_idempotency_key(make_client):
    h = recorder(MINTED, 201)
    make_client(h).embeds.create(resource={"type": "gems", "id": "s1"}, origins=["https://a.test"])
    assert "idempotency-key" not in h.seen["requests"][0].headers


def test_create_omits_filters_and_ttl_when_not_given(make_client):
    h = recorder(MINTED, 201)
    make_client(h).embeds.create(resource={"type": "gems", "id": "s1"}, origins=["https://a.test"])
    assert body_of(h.seen["requests"][0]) == {
        "resource": {"type": "gems", "id": "s1"},
        "origins": ["https://a.test"],
    }


def test_the_token_and_url_stay_out_of_repr_and_src_has_no_fragment(make_client):
    embed = make_client(recorder(MINTED, 201)).embeds.create(
        resource={"type": "dashboard", "id": "d_123"}, origins=["https://app.customer.com"]
    )
    assert TOKEN not in repr(embed) and "#token" not in repr(embed)
    assert embed.src == "https://workspace.matih.ai/embed/dashboards/d_123?e=emt_Ab12"
    assert "#" not in embed.src and TOKEN not in embed.src
    assert embed_src(URL) == embed.src
    assert embed_src("https://x.test/embed/gems/c1?e=emt_1") == "https://x.test/embed/gems/c1?e=emt_1"


def test_create_does_not_retry_a_server_error(make_client):
    h = recorder({"detail": {"category": "internal", "message": "boom"}}, 500)
    with pytest.raises(MitraError):
        make_client(h, max_retries=2).embeds.create(
            resource={"type": "gems", "id": "s1"}, origins=["https://a.test"]
        )
    assert len(h.seen["requests"]) == 1  # a retry could mint a second token


@pytest.mark.parametrize(
    "bad",
    [
        {"resource": {"type": "dashboard"}, "origins": ["https://a.test"]},
        {"resource": "dashboard:d_1", "origins": ["https://a.test"]},
        {"resource": {"type": "gems", "id": "s1"}, "origins": []},
        {"resource": {"type": "gems", "id": "s1"}, "origins": "https://a.test"},
    ],
)
def test_create_rejects_a_malformed_call_before_sending(make_client, bad):
    h = recorder(MINTED, 201)
    with pytest.raises(ValueError):
        make_client(h).embeds.create(**bad)
    assert h.seen["requests"] == []


@pytest.mark.parametrize("code", list(EMBED_REFUSAL_CODES))
def test_create_maps_each_422_code(make_client, code):
    client = make_client(recorder(refusal(code, f"because {code}"), 422))
    with pytest.raises(EmbedRefusedError) as info:
        client.embeds.create(
            resource={"type": "dashboard", "id": "d_123"},
            filters={"customer_id": "C123"},
            origins=["https://app.customer.com"],
        )
    err = info.value
    assert isinstance(err, MitraError)
    assert err.status == 422 and err.code == code
    assert err.category == "validation"
    assert err.message == f"because {code}"


def test_the_contract_lists_the_codes_this_sdk_maps():
    assert set(EMBED_REFUSAL_CODES) == {
        "missing_parameter",
        "unknown_parameter",
        "invalid_value",
        "invalid_origin",
        "filters_not_supported",
        "no_embed_parameters",
    }


def test_a_top_level_code_is_read_when_the_envelope_has_none(make_client):
    payload = {"detail": "Origins must be exact origins", "code": "invalid_origin"}
    client = make_client(recorder(payload, 422))
    with pytest.raises(EmbedRefusedError) as info:
        client.embeds.create(resource={"type": "gems", "id": "s1"}, origins=["*"])
    assert info.value.code == "invalid_origin"
    assert info.value.message == "Origins must be exact origins"


def test_a_request_validation_422_is_an_embed_refusal_with_a_readable_message(make_client):
    payload = {"detail": [{"loc": ["body", "ttl_seconds"], "msg": "must be at most 900"}]}
    client = make_client(recorder(payload, 422))
    with pytest.raises(EmbedRefusedError) as info:
        client.embeds.create(
            resource={"type": "gems", "id": "s1"}, origins=["https://a.test"], ttl_seconds=5000
        )
    assert info.value.code is None
    assert "ttl_seconds: must be at most 900" in info.value.message


def test_create_404_is_embed_not_found(make_client):
    payload = {"detail": {"category": "not_found", "message": "Dashboard not found"}}
    client = make_client(recorder(payload, 404))
    with pytest.raises(EmbedNotFoundError) as info:
        client.embeds.create(resource={"type": "dashboard", "id": "nope"}, origins=["https://a.test"])
    assert info.value.status == 404 and info.value.category == "not_found"


def test_other_statuses_keep_their_existing_classes(make_client):
    cases = [
        (401, AuthError),
        (403, PermissionDeniedError),
        (429, RateLimitError),
    ]
    for status, cls in cases:
        payload = {"detail": {"category": "x", "message": "m"}}
        client = make_client(recorder(payload, status))
        with pytest.raises(cls):
            client.embeds.create(resource={"type": "gems", "id": "s1"}, origins=["https://a.test"])


def test_a_422_elsewhere_is_not_an_embed_refusal(make_client):
    client = make_client(recorder(refusal("invalid_value"), 422))
    with pytest.raises(MitraError) as info:
        client.invitations.revoke("i1")
    assert not isinstance(info.value, EmbedRefusedError)
    # and a 404 elsewhere is still a plain MitraError
    client = make_client(recorder({"detail": {"category": "not_found", "message": "x"}}, 404))
    with pytest.raises(MitraError) as info:
        client.invitations.revoke("i1")
    assert not isinstance(info.value, EmbedNotFoundError)


def test_list_parses_summaries_without_secrets(make_client):
    payload = {
        "embeds": [
            {
                "id": "emt_Ab12",
                "resource": {"type": "dashboard", "id": "d_123"},
                "origins": ["https://app.customer.com"],
                "created_at": "2026-10-31T10:00:00Z",
                "expires_at": "2026-10-31T10:05:00Z",
                "revoked": False,
            },
            {"id": "emt_Cd34", "resource": {"type": "gems", "id": "s1"}, "revoked": True},
        ]
    }
    h = recorder(payload)
    out = make_client(h).embeds.list()
    request = h.seen["requests"][0]
    assert request.method == "GET" and str(request.url).endswith("/api/v1/embeds")
    assert [e.id for e in out.embeds] == ["emt_Ab12", "emt_Cd34"]
    assert out.embeds[0].resource.id == "d_123" and out.embeds[0].revoked is False
    assert out.embeds[1].revoked is True and out.embeds[1].origins == []
    assert not hasattr(out.embeds[0], "token")


def test_revoke_deletes_by_id_and_returns_none(make_client):
    h = recorder(status=204)
    assert make_client(h).embeds.revoke("emt_Ab12") is None
    request = h.seen["requests"][0]
    assert request.method == "DELETE"
    assert str(request.url) == "https://workspace.matih.ai/api/v1/embeds/emt_Ab12"


def test_revoke_escapes_the_id_and_404_is_embed_not_found(make_client):
    h = recorder({"detail": {"category": "not_found", "message": "No such token"}}, 404)
    with pytest.raises(EmbedNotFoundError):
        make_client(h).embeds.revoke("a/b")
    assert h.seen["requests"][0].url.raw_path.endswith(b"/api/v1/embeds/a%2Fb")


# ------------------------------------------------------------------ async parity


async def test_async_create_list_revoke(make_async_client):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.method == "POST":
            return json_response(MINTED, 201)
        if request.method == "GET":
            return json_response({"embeds": [{"id": "emt_Ab12"}]})
        return httpx.Response(204)

    client = make_async_client(handler)
    embed = await client.embeds.create(
        resource={"type": "dashboard", "id": "d_123"},
        filters={"customer_id": "C123"},
        origins=["https://app.customer.com"],
        ttl_seconds=120,
    )
    assert embed.token == TOKEN and embed.src.endswith("?e=emt_Ab12")
    assert body_of(calls[0])["ttl_seconds"] == 120
    assert [e.id for e in (await client.embeds.list()).embeds] == ["emt_Ab12"]
    assert await client.embeds.revoke("emt_Ab12") is None
    assert [c.method for c in calls] == ["POST", "GET", "DELETE"]
    assert "idempotency-key" not in calls[0].headers


async def test_async_maps_422_and_404(make_async_client):
    client = make_async_client(lambda r: json_response(refusal("filters_not_supported"), 422))
    with pytest.raises(EmbedRefusedError) as info:
        await client.embeds.create(
            resource={"type": "gems", "id": "s1"},
            filters={"customer_id": "C1"},
            origins=["https://a.test"],
        )
    assert info.value.code == "filters_not_supported"

    client = make_async_client(
        lambda r: json_response({"detail": {"category": "not_found", "message": "x"}}, 404)
    )
    with pytest.raises(EmbedNotFoundError):
        await client.embeds.revoke("emt_missing")


async def test_async_create_validates_before_sending(make_async_client):
    client = make_async_client(lambda r: json_response(MINTED, 201))
    with pytest.raises(ValueError):
        await client.embeds.create(resource={"type": "gems", "id": "s1"}, origins=[])
