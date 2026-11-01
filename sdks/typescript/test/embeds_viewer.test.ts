/**
 * embeds.create with a viewer and an `ask` resource, and embeds.keys.add / list / revoke, against
 * docs/EMBEDS.md section 3.1b of matih-labs/mitra (branch ea/viewer-identity).
 * Mirrors sdks/python/tests/test_embed_viewers.py.
 */
import { describe, expect, it } from "vitest";
import { EmbedNotFoundError, EmbedRefusedError, MitraError, PermissionError } from "../src/index.js";
import { jsonResponse, makeClient, sequence } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const PEM = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n";
const KEY = {
  id: "esk_Ab12",
  kid: "k1",
  alg: "ES256",
  public_key: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  created_at: "2026-11-01T10:00:00Z",
  revoked_at: null,
};
const MINTED = {
  id: "emt_Ab12",
  token: "met_secretsecretsecret",
  expires_at: "2026-11-01T10:05:00Z",
  url: "https://workspace.matih.ai/embed/dashboards/d_123?e=emt_Ab12#token=met_secretsecretsecret",
  resource: { type: "dashboard", id: "d_123" },
  origins: ["https://app.customer.com"],
  viewer: { id: "vwr_Qw12" },
};
const refusal = (code: string, message = "refused") => ({ detail: { category: "validation", message, code } });

describe("embeds.create with a viewer", () => {
  it("sends the viewer object as given and returns its id", async () => {
    const m = sequence(jsonResponse(MINTED, 201));
    const viewer = {
      external_id: "cust-42",
      name: "Asha Rao",
      locale: "en-IN",
      attributes: { plan: "pro", regions: ["south", "west"], seats: 4 },
    };
    const embed = await makeClient(m.fetch).embeds.create({
      resource: { type: "dashboard", id: "d_123" },
      origins: ["https://app.customer.com"],
      viewer,
    });
    expect(JSON.parse(String(m.calls[0].body))).toEqual({
      resource: { type: "dashboard", id: "d_123" },
      origins: ["https://app.customer.com"],
      viewer,
    });
    expect(embed.viewer?.id).toBe("vwr_Qw12");
  });

  it("omits viewer when not given", async () => {
    const m = sequence(jsonResponse(MINTED, 201));
    await makeClient(m.fetch).embeds.create({
      resource: { type: "dashboard", id: "d_123" },
      origins: ["https://app.customer.com"],
    });
    expect(Object.keys(JSON.parse(String(m.calls[0].body)))).not.toContain("viewer");
  });

  it("accepts an ask resource", async () => {
    const m = sequence(jsonResponse({ ...MINTED, resource: { type: "ask", id: "s1" } }, 201));
    const embed = await makeClient(m.fetch).embeds.create({
      resource: { type: "ask", id: "s1" },
      origins: ["https://app.customer.com"],
      viewer: { external_id: "cust-42" },
    });
    expect(JSON.parse(String(m.calls[0].body)).resource).toEqual({ type: "ask", id: "s1" });
    expect(embed.resource.type).toBe("ask");
  });

  it("maps a viewer refusal to EmbedRefusedError with the claim's code", async () => {
    const m = sequence(jsonResponse(refusal("external_id_missing", "viewer.external_id is required"), 422));
    const err = await makeClient(m.fetch)
      .embeds.create({
        resource: { type: "dashboard", id: "d_123" },
        origins: ["https://app.customer.com"],
        viewer: { external_id: "" },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedRefusedError);
    expect((err as EmbedRefusedError).code).toBe("external_id_missing");
  });
});

describe("embeds.keys", () => {
  it("adds a PEM public key (201) with the kid and alg", async () => {
    const m = sequence(jsonResponse(KEY, 201));
    const key = await makeClient(m.fetch).embeds.keys.add({ publicKey: PEM, kid: "k1", alg: "ES256" });
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].url).toBe(`${BASE}/embeds/keys`);
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ public_key: PEM, kid: "k1", alg: "ES256" });
    expect(key.id).toBe("esk_Ab12");
    expect(key.revoked_at).toBeNull();
  });

  it("adds a JWK and leaves kid and alg out when not given", async () => {
    const m = sequence(jsonResponse(KEY, 201));
    const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k1" };
    await makeClient(m.fetch).embeds.keys.add({ publicKey: jwk });
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ public_key: jwk });
  });

  it("rejects a publicKey that is neither a string nor an object, without a request", async () => {
    const m = sequence(jsonResponse(KEY, 201));
    // @ts-expect-error a number is no key
    const err = await makeClient(m.fetch).embeds.keys.add({ publicKey: 7 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(m.calls).toHaveLength(0);
  });

  it("maps key_private to EmbedRefusedError", async () => {
    const m = sequence(jsonResponse(refusal("key_private", "that is a private key"), 422));
    const err = await makeClient(m.fetch)
      .embeds.keys.add({ publicKey: "-----BEGIN PRIVATE KEY-----" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedRefusedError);
    expect((err as EmbedRefusedError).code).toBe("key_private");
  });

  it("a 409 kid_taken is a conflict, not an embed refusal", async () => {
    const m = sequence(jsonResponse({ detail: { category: "conflict", message: "kid in use", code: "kid_taken" } }, 409));
    const err = await makeClient(m.fetch)
      .embeds.keys.add({ publicKey: PEM, kid: "k1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MitraError);
    expect(err).not.toBeInstanceOf(EmbedRefusedError);
  });

  it("a 403 is a PermissionError", async () => {
    const m = sequence(jsonResponse({ detail: { category: "permission", message: "no" } }, 403));
    const err = await makeClient(m.fetch).embeds.keys.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
  });

  it("lists keys, live and revoked", async () => {
    const m = sequence(
      jsonResponse({ keys: [KEY, { ...KEY, id: "esk_Cd34", kid: "k0", revoked_at: "2026-11-01T11:00:00Z" }] }),
    );
    const out = await makeClient(m.fetch).embeds.keys.list();
    expect(m.calls[0].method).toBe("GET");
    expect(m.calls[0].url).toBe(`${BASE}/embeds/keys`);
    expect(out.keys.map((k) => k.kid)).toEqual(["k1", "k0"]);
    expect(out.keys[1]?.revoked_at).toBe("2026-11-01T11:00:00Z");
    expect(JSON.stringify(out)).not.toContain("PRIVATE");
  });

  it("revokes by id (204) and resolves to undefined", async () => {
    const m = sequence(() => new Response(null, { status: 204 }));
    await expect(makeClient(m.fetch).embeds.keys.revoke("esk_Ab12")).resolves.toBeUndefined();
    expect(m.calls[0].method).toBe("DELETE");
    expect(m.calls[0].url).toBe(`${BASE}/embeds/keys/esk_Ab12`);
  });

  it("escapes the id and maps 404 to EmbedNotFoundError", async () => {
    const m = sequence(jsonResponse({ detail: { category: "not_found", message: "no such key" } }, 404));
    const err = await makeClient(m.fetch).embeds.keys.revoke("a/b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedNotFoundError);
    expect(m.calls[0].url).toBe(`${BASE}/embeds/keys/a%2Fb`);
  });
});

describe("embeds.origins (a token you sign is framed by these)", () => {
  it("PUTs the origins and returns what was stored", async () => {
    const m = sequence(jsonResponse({ origins: ["https://app.customer.com", "http://localhost:3000"] }));
    const out = await makeClient(m.fetch).embeds.origins.set(["https://App.customer.com", "http://localhost:3000"]);
    expect(m.calls[0].method).toBe("PUT");
    expect(m.calls[0].url).toBe(`${BASE}/embeds/origins`);
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ origins: ["https://App.customer.com", "http://localhost:3000"] });
    expect(out.origins).toEqual(["https://app.customer.com", "http://localhost:3000"]);
  });

  it("GETs them, empty until set", async () => {
    const m = sequence(jsonResponse({ origins: [] }));
    const out = await makeClient(m.fetch).embeds.origins.get();
    expect(m.calls[0].method).toBe("GET");
    expect(m.calls[0].url).toBe(`${BASE}/embeds/origins`);
    expect(out.origins).toEqual([]);
  });

  it("refuses what is not an array of strings before sending", async () => {
    const m = sequence(jsonResponse({ origins: [] }));
    const client = makeClient(m.fetch);
    for (const bad of ["https://app.customer.com", [1], ["https://a.customer.com", null]]) {
      const err = await client.embeds.origins.set(bad as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
    }
    expect(m.calls).toHaveLength(0);
  });

  it("maps 422 invalid_origin to EmbedRefusedError and 403 to PermissionError", async () => {
    const invalid = sequence(jsonResponse(refusal("invalid_origin", "an origin is scheme://host"), 422));
    const err = await makeClient(invalid.fetch).embeds.origins.set(["http://evil.test"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedRefusedError);
    expect((err as EmbedRefusedError).code).toBe("invalid_origin");
    const denied = sequence(jsonResponse({ detail: { category: "permission", message: "no" } }, 403));
    const forbidden = await makeClient(denied.fetch).embeds.origins.set(["https://a.customer.com"]).catch((e: unknown) => e);
    expect(forbidden).toBeInstanceOf(PermissionError);
  });
});
