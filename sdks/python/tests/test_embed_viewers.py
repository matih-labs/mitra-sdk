"""embeds.create with a viewer and an ``ask`` resource, and embeds.keys add / list / revoke, on both
clients, against docs/EMBEDS.md section 3.1b of matih-labs/mitra (branch ea/viewer-identity).
Mirrors sdks/typescript/test/embeds_viewer.test.ts."""

from __future__ import annotations

import httpx
import pytest
from conftest import body_of, json_response

from mitra import (
    BusyError,
    Embed,
    EmbedNotFoundError,
    EmbedRefusedError,
    EmbedSigningKey,
    EmbedSigningKeyList,
    MitraError,
    PermissionDeniedError,
)

PEM = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n"
KEY = {
    "id": "esk_Ab12",
    "kid": "k1",
    "alg": "ES256",
    "public_key": {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"},
    "created_at": "2026-11-01T10:00:00Z",
    "revoked_at": None,
}
MINTED = {
    "id": "emt_Ab12",
    "token": "met_secretsecretsecret",
    "expires_at": "2026-11-01T10:05:00Z",
    "url": "https://workspace.matih.ai/embed/dashboards/d_123?e=emt_Ab12#token=met_secretsecretsecret",
    "resource": {"type": "dashboard", "id": "d_123"},
    "origins": ["https://app.customer.com"],
    "viewer": {"id": "vwr_Qw12"},
}
DASHBOARD = {"type": "dashboard", "id": "d_123"}
ORIGINS = ["https://app.customer.com"]


def refusal(code: str, message: str = "refused"):
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


# ------------------------------------------------------------------ create with a viewer


def test_create_sends_the_viewer_as_given_and_returns_its_id(make_client):
    h = recorder(MINTED, 201)
    viewer = {
        "external_id": "cust-42",
        "name": "Asha Rao",
        "locale": "en-IN",
        "attributes": {"plan": "pro", "regions": ["south", "west"], "seats": 4},
    }
    embed = make_client(h).embeds.create(resource=DASHBOARD, origins=ORIGINS, viewer=viewer)
    assert body_of(h.seen["requests"][0]) == {"resource": DASHBOARD, "origins": ORIGINS, "viewer": viewer}
    assert isinstance(embed, Embed)
    assert embed.viewer is not None and embed.viewer.id == "vwr_Qw12"
    assert "met_" not in repr(embed)


def test_create_omits_viewer_when_not_given(make_client):
    h = recorder(MINTED, 201)
    make_client(h).embeds.create(resource=DASHBOARD, origins=ORIGINS)
    assert "viewer" not in body_of(h.seen["requests"][0])


def test_a_token_without_a_viewer_has_none(make_client):
    minted = {k: v for k, v in MINTED.items() if k != "viewer"}
    embed = make_client(recorder(minted, 201)).embeds.create(resource=DASHBOARD, origins=ORIGINS)
    assert embed.viewer is None


def test_create_accepts_an_ask_resource(make_client):
    h = recorder({**MINTED, "resource": {"type": "ask", "id": "s1"}}, 201)
    embed = make_client(h).embeds.create(
        resource={"type": "ask", "id": "s1"}, origins=ORIGINS, viewer={"external_id": "cust-42"}
    )
    assert body_of(h.seen["requests"][0])["resource"] == {"type": "ask", "id": "s1"}
    assert embed.resource.type == "ask"


def test_create_rejects_a_viewer_that_is_not_a_dict_before_sending(make_client):
    h = recorder(MINTED, 201)
    with pytest.raises(ValueError):
        make_client(h).embeds.create(resource=DASHBOARD, origins=ORIGINS, viewer="cust-42")  # type: ignore[arg-type]
    assert h.seen["requests"] == []


def test_a_viewer_refusal_carries_the_claims_code(make_client):
    client = make_client(recorder(refusal("external_id_missing", "viewer.external_id is required"), 422))
    with pytest.raises(EmbedRefusedError) as info:
        client.embeds.create(resource=DASHBOARD, origins=ORIGINS, viewer={"external_id": ""})
    assert info.value.status == 422 and info.value.code == "external_id_missing"


# ------------------------------------------------------------------ keys


def test_keys_add_sends_a_pem_with_kid_and_alg(make_client):
    h = recorder(KEY, 201)
    key = make_client(h).embeds.keys.add(public_key=PEM, kid="k1", alg="ES256")
    request = h.seen["requests"][0]
    assert request.method == "POST"
    assert str(request.url) == "https://workspace.matih.ai/api/v1/embeds/keys"
    assert body_of(request) == {"public_key": PEM, "kid": "k1", "alg": "ES256"}
    assert isinstance(key, EmbedSigningKey)
    assert key.id == "esk_Ab12" and key.revoked_at is None


def test_keys_add_sends_a_jwk_and_leaves_kid_and_alg_out_when_not_given(make_client):
    h = recorder(KEY, 201)
    jwk = {"kty": "EC", "crv": "P-256", "x": "x", "y": "y", "kid": "k1"}
    make_client(h).embeds.keys.add(public_key=jwk)
    assert body_of(h.seen["requests"][0]) == {"public_key": jwk}


def test_keys_add_rejects_a_public_key_that_is_neither_a_string_nor_a_dict(make_client):
    h = recorder(KEY, 201)
    with pytest.raises(ValueError):
        make_client(h).embeds.keys.add(public_key=7)  # type: ignore[arg-type]
    assert h.seen["requests"] == []


def test_keys_add_maps_key_private_to_embed_refused(make_client):
    client = make_client(recorder(refusal("key_private", "that is a private key"), 422))
    with pytest.raises(EmbedRefusedError) as info:
        client.embeds.keys.add(public_key="-----BEGIN PRIVATE KEY-----")
    assert info.value.code == "key_private"


def test_a_409_kid_taken_is_a_conflict_not_an_embed_refusal(make_client):
    client = make_client(
        recorder({"detail": {"category": "conflict", "message": "kid in use", "code": "kid_taken"}}, 409)
    )
    with pytest.raises(BusyError) as info:
        client.embeds.keys.add(public_key=PEM, kid="k1")
    assert isinstance(info.value, MitraError) and not isinstance(info.value, EmbedRefusedError)
    assert info.value.code == "kid_taken"


def test_keys_list_returns_live_and_revoked(make_client):
    revoked = {**KEY, "id": "esk_Cd34", "kid": "k0", "revoked_at": "2026-11-01T11:00:00Z"}
    h = recorder({"keys": [KEY, revoked]})
    out = make_client(h).embeds.keys.list()
    request = h.seen["requests"][0]
    assert request.method == "GET"
    assert str(request.url) == "https://workspace.matih.ai/api/v1/embeds/keys"
    assert isinstance(out, EmbedSigningKeyList)
    assert [k.kid for k in out.keys] == ["k1", "k0"]
    assert out.keys[1].revoked_at == "2026-11-01T11:00:00Z"
    assert "PRIVATE" not in repr(out)


def test_keys_list_maps_403(make_client):
    client = make_client(recorder({"detail": {"category": "permission", "message": "no"}}, 403))
    with pytest.raises(PermissionDeniedError):
        client.embeds.keys.list()


def test_keys_revoke_is_a_204_delete_and_returns_none(make_client):
    h = recorder(status=204)
    assert make_client(h).embeds.keys.revoke("esk_Ab12") is None
    request = h.seen["requests"][0]
    assert request.method == "DELETE"
    assert str(request.url) == "https://workspace.matih.ai/api/v1/embeds/keys/esk_Ab12"


def test_keys_revoke_escapes_the_id_and_maps_404(make_client):
    h = recorder({"detail": {"category": "not_found", "message": "no such key"}}, 404)
    with pytest.raises(EmbedNotFoundError):
        make_client(h).embeds.keys.revoke("a/b")
    assert h.seen["requests"][0].url.raw_path.endswith(b"/api/v1/embeds/keys/a%2Fb")


# ------------------------------------------------------------------ async parity


async def test_async_create_with_a_viewer_and_keys(make_async_client):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        path = request.url.path
        if request.method == "POST" and path.endswith("/embeds/keys"):
            return json_response(KEY, 201)
        if request.method == "POST":
            return json_response(MINTED, 201)
        if request.method == "GET":
            return json_response({"keys": [KEY]})
        return httpx.Response(204)

    client = make_async_client(handler)
    embed = await client.embeds.create(resource=DASHBOARD, origins=ORIGINS, viewer={"external_id": "cust-42"})
    assert embed.viewer is not None and embed.viewer.id == "vwr_Qw12"
    assert body_of(calls[0])["viewer"] == {"external_id": "cust-42"}
    key = await client.embeds.keys.add(public_key=PEM, kid="k1")
    assert key.id == "esk_Ab12"
    assert [k.id for k in (await client.embeds.keys.list()).keys] == ["esk_Ab12"]
    assert await client.embeds.keys.revoke("esk_Ab12") is None
    assert [c.method for c in calls] == ["POST", "POST", "GET", "DELETE"]


async def test_async_maps_key_refusals(make_async_client):
    client = make_async_client(lambda r: json_response(refusal("key_too_weak"), 422))
    with pytest.raises(EmbedRefusedError) as info:
        await client.embeds.keys.add(public_key=PEM)
    assert info.value.code == "key_too_weak"


async def test_async_create_validates_the_viewer_before_sending(make_async_client):
    client = make_async_client(lambda r: json_response(MINTED, 201))
    with pytest.raises(ValueError):
        await client.embeds.create(resource=DASHBOARD, origins=ORIGINS, viewer=["cust-42"])  # type: ignore[arg-type]
