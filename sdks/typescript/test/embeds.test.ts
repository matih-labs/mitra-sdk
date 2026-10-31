/**
 * embeds.create / list / revoke against docs/EMBEDS.md section 3.1 of matih-labs/mitra
 * (branch feat/embeds): the mint request and response, and the 422 and 404 refusals.
 * Mirrors sdks/python/tests/test_embeds.py.
 */
import { describe, expect, it } from "vitest";
import {
  AuthError,
  EMBED_REFUSAL_CODES,
  EmbedNotFoundError,
  EmbedRefusedError,
  MitraError,
  PermissionError,
  RateLimitError,
  embedSrc,
} from "../src/index.js";
import { jsonResponse, makeClient, sequence } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const TOKEN = "met_secretsecretsecret";
const URL_WITH_TOKEN = `https://workspace.matih.ai/embed/dashboards/d_123?e=emt_Ab12#token=${TOKEN}`;
const MINTED = {
  id: "emt_Ab12",
  token: TOKEN,
  expires_at: "2026-10-31T10:05:00Z",
  url: URL_WITH_TOKEN,
  resource: { type: "dashboard", id: "d_123" },
  origins: ["https://app.customer.com"],
};
const refusal = (code: string, message = "refused") => ({ detail: { category: "validation", message, code } });
const DASHBOARD = { type: "dashboard", id: "d_123" } as const;
const GEMS = { type: "gems", id: "s1" } as const;

describe("embeds.create", () => {
  it("sends the contract body and returns the minted token", async () => {
    const m = sequence(jsonResponse(MINTED, 201));
    const embed = await makeClient(m.fetch).embeds.create({
      resource: DASHBOARD,
      filters: { customer_id: "C123" },
      origins: ["https://app.customer.com"],
      ttlSeconds: 300,
    });
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].url).toBe(`${BASE}/embeds`);
    expect(m.calls[0].headers.get("authorization")).toBe("Bearer mtk_test");
    expect(JSON.parse(String(m.calls[0].body))).toEqual({
      resource: { type: "dashboard", id: "d_123" },
      filters: { customer_id: "C123" },
      origins: ["https://app.customer.com"],
      ttl_seconds: 300,
    });
    expect(embed.id).toBe("emt_Ab12");
    expect(embed.token).toBe(TOKEN);
    expect(embed.expires_at).toBe("2026-10-31T10:05:00Z");
    expect(embed.resource).toEqual(DASHBOARD);
    expect(embed.origins).toEqual(["https://app.customer.com"]);
  });

  it("omits filters and ttl_seconds when not given, and sends no Idempotency-Key", async () => {
    const m = sequence(jsonResponse(MINTED, 201));
    await makeClient(m.fetch).embeds.create({ resource: GEMS, origins: ["https://a.test"] });
    expect(JSON.parse(String(m.calls[0].body))).toEqual({
      resource: { type: "gems", id: "s1" },
      origins: ["https://a.test"],
    });
    expect(m.calls[0].headers.get("idempotency-key")).toBeNull();
  });

  it("does not retry a 5xx: a retry could mint a second token", async () => {
    const m = sequence(jsonResponse({ detail: { category: "internal", message: "boom" } }, 500));
    await expect(
      makeClient(m.fetch, { maxRetries: 2 }).embeds.create({ resource: GEMS, origins: ["https://a.test"] }),
    ).rejects.toBeInstanceOf(MitraError);
    expect(m.calls).toHaveLength(1);
  });

  it("rejects a malformed call before sending", async () => {
    const m = sequence(jsonResponse(MINTED, 201));
    const c = makeClient(m.fetch);
    await expect(c.embeds.create({ resource: GEMS, origins: [] })).rejects.toBeInstanceOf(TypeError);
    await expect(
      c.embeds.create({ resource: { type: "gems" } as never, origins: ["https://a.test"] }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      c.embeds.create({ resource: GEMS, origins: "https://a.test" as never }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(m.calls).toHaveLength(0);
  });

  it.each([...EMBED_REFUSAL_CODES])("maps 422 %s to EmbedRefusedError with the code", async (code) => {
    const m = sequence(jsonResponse(refusal(code, `because ${code}`), 422, { "x-request-id": "req_9" }));
    const err = await makeClient(m.fetch)
      .embeds.create({ resource: DASHBOARD, filters: { customer_id: "C1" }, origins: ["https://a.test"] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedRefusedError);
    expect(err).toBeInstanceOf(MitraError);
    const e = err as EmbedRefusedError;
    expect(e.status).toBe(422);
    expect(e.code).toBe(code);
    expect(e.category).toBe("validation");
    expect(e.message).toBe(`because ${code}`);
    expect(e.requestId).toBe("req_9");
  });

  it("lists exactly the codes the contract names", () => {
    expect([...EMBED_REFUSAL_CODES].sort()).toEqual(
      [
        "filters_not_supported",
        "invalid_origin",
        "invalid_value",
        "missing_parameter",
        "no_embed_parameters",
        "unknown_parameter",
      ].sort(),
    );
  });

  it("reads a top-level code when the envelope has none", async () => {
    const m = sequence(jsonResponse({ detail: "Origins must be exact origins", code: "invalid_origin" }, 422));
    const err = (await makeClient(m.fetch)
      .embeds.create({ resource: GEMS, origins: ["*"] })
      .catch((e: unknown) => e)) as EmbedRefusedError;
    expect(err).toBeInstanceOf(EmbedRefusedError);
    expect(err.code).toBe("invalid_origin");
    expect(err.message).toBe("Origins must be exact origins");
  });

  it("maps a request-validation 422 (a detail array) to EmbedRefusedError without a code", async () => {
    const m = sequence(jsonResponse({ detail: [{ loc: ["body", "ttl_seconds"], msg: "must be at most 900" }] }, 422));
    const err = (await makeClient(m.fetch)
      .embeds.create({ resource: GEMS, origins: ["https://a.test"], ttlSeconds: 5000 })
      .catch((e: unknown) => e)) as EmbedRefusedError;
    expect(err).toBeInstanceOf(EmbedRefusedError);
    expect(err.code).toBeUndefined();
    expect(err.message).toContain("ttl_seconds: must be at most 900");
  });

  it("maps 404 to EmbedNotFoundError", async () => {
    const m = sequence(jsonResponse({ detail: { category: "not_found", message: "Dashboard not found" } }, 404));
    const err = await makeClient(m.fetch)
      .embeds.create({ resource: { type: "dashboard", id: "nope" }, origins: ["https://a.test"] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedNotFoundError);
    expect((err as EmbedNotFoundError).status).toBe(404);
    expect((err as EmbedNotFoundError).category).toBe("not_found");
  });

  it("keeps the existing classes for other statuses", async () => {
    const detail = { detail: { category: "x", message: "m" } };
    for (const [status, cls] of [
      [401, AuthError],
      [403, PermissionError],
      [429, RateLimitError],
    ] as const) {
      const m = sequence(jsonResponse(detail, status));
      const err = await makeClient(m.fetch, { maxRetries: 0 })
        .embeds.create({ resource: GEMS, origins: ["https://a.test"] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(cls);
      expect(err).not.toBeInstanceOf(EmbedRefusedError);
    }
  });

  it("a 422 or 404 on another route is not an embed error", async () => {
    const m = sequence(jsonResponse(refusal("invalid_value"), 422), jsonResponse({ detail: "x" }, 404));
    const c = makeClient(m.fetch);
    const a = await c.invitations.revoke("i1").catch((e: unknown) => e);
    expect(a).toBeInstanceOf(MitraError);
    expect(a).not.toBeInstanceOf(EmbedRefusedError);
    const b = await c.invitations.revoke("i1").catch((e: unknown) => e);
    expect(b).not.toBeInstanceOf(EmbedNotFoundError);
  });
});

describe("embeds.list and embeds.revoke", () => {
  it("lists what this key minted", async () => {
    const m = sequence(
      jsonResponse({
        embeds: [
          {
            id: "emt_Ab12",
            resource: DASHBOARD,
            origins: ["https://app.customer.com"],
            created_at: "2026-10-31T10:00:00Z",
            expires_at: "2026-10-31T10:05:00Z",
            revoked: false,
          },
          { id: "emt_Cd34", resource: GEMS, revoked: true },
        ],
      }),
    );
    const out = await makeClient(m.fetch).embeds.list();
    expect(m.calls[0].method).toBe("GET");
    expect(m.calls[0].url).toBe(`${BASE}/embeds`);
    expect(out.embeds.map((e) => e.id)).toEqual(["emt_Ab12", "emt_Cd34"]);
    expect(out.embeds[1]?.revoked).toBe(true);
    expect(JSON.stringify(out)).not.toContain("met_");
  });

  it("revokes by id (204) and resolves to undefined", async () => {
    const m = sequence(() => new Response(null, { status: 204 }));
    await expect(makeClient(m.fetch).embeds.revoke("emt_Ab12")).resolves.toBeUndefined();
    expect(m.calls[0].method).toBe("DELETE");
    expect(m.calls[0].url).toBe(`${BASE}/embeds/emt_Ab12`);
  });

  it("escapes the id and maps 404 to EmbedNotFoundError", async () => {
    const m = sequence(jsonResponse({ detail: { category: "not_found", message: "No such token" } }, 404));
    const err = await makeClient(m.fetch)
      .embeds.revoke("a/b")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedNotFoundError);
    expect(m.calls[0].url).toBe(`${BASE}/embeds/a%2Fb`);
  });
});

describe("embedSrc", () => {
  it("drops the fragment (the token) and keeps the ?e= token id", () => {
    expect(embedSrc(URL_WITH_TOKEN)).toBe("https://workspace.matih.ai/embed/dashboards/d_123?e=emt_Ab12");
    expect(embedSrc({ ...MINTED, resource: DASHBOARD })).not.toContain(TOKEN);
  });

  it("leaves a URL with no fragment alone", () => {
    expect(embedSrc("https://x.test/embed/gems/c1?e=emt_1")).toBe("https://x.test/embed/gems/c1?e=emt_1");
  });
});
