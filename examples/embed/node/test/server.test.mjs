import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Mitra } from "@matihlabs/mitra";
import { createApp } from "../server.mjs";

const APP_ORIGIN = "http://localhost:3000";
const elementFile = fileURLToPath(new URL("./fixtures/element.js", import.meta.url));

/** A Mitra client whose "Matih" is a function; every call it receives is recorded. */
function fakeMatih(answer) {
  const calls = [];
  const fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body: init?.body });
    const { status, body } = answer(calls.length);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, mitra: new Mitra({ apiKey: "mtk_test", baseUrl: "https://matih.test", fetch, maxRetries: 0 }) };
}

const minted = {
  id: "emt_Ab12",
  token: "met_secret",
  expires_at: "2026-10-31T10:05:00Z",
  url: "https://matih.test/embed/dashboards/d_123?e=emt_Ab12#token=met_secret",
  resource: { type: "dashboard", id: "d_123" },
  origins: [APP_ORIGIN],
};

async function start(app) {
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

const post = (base, headers = { "Content-Type": "application/json" }, body = "{}") =>
  fetch(`${base}/api/matih-embed-token`, { method: "POST", headers, body });

describe("dashboard embed", () => {
  const { calls, mitra } = fakeMatih(() => ({ status: 201, body: minted }));
  const app = createApp({ mitra, resource: { type: "dashboard", id: "d_123" }, appOrigin: APP_ORIGIN, elementFile });
  let base;
  before(async () => {
    base = await start(app);
  });
  after(() => app.close());

  it("mints with the viewer's filter and this page's origin, and answers token + src", async () => {
    const res = await post(base);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.deepEqual(body, { token: "met_secret", src: "https://matih.test/embed/dashboards/d_123?e=emt_Ab12" });
    assert.ok(!body.src.includes("#"));

    const call = calls.at(-1);
    assert.equal(call.method, "POST");
    assert.equal(call.url, "https://matih.test/api/v1/embeds");
    assert.equal(call.headers.get("authorization"), "Bearer mtk_test");
    assert.deepEqual(JSON.parse(call.body), {
      resource: { type: "dashboard", id: "d_123" },
      origins: [APP_ORIGIN],
      filters: { customer_id: "C123" },
      ttl_seconds: 300,
    });
  });

  it("mints again on a refresh and ignores what the body says", async () => {
    const count = calls.length;
    const body = JSON.stringify({ embed: "emt_Ab12", filters: { customer_id: "C999" } });
    const res = await post(base, { "Content-Type": "application/json" }, body);
    assert.equal(res.status, 200);
    assert.equal(calls.length, count + 1);
    assert.equal(JSON.parse(calls.at(-1).body).filters.customer_id, "C123");
  });

  it("refuses what the element never sends", async () => {
    const count = calls.length;
    assert.equal((await post(base, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post(base, { "Content-Type": "application/json", Origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(`${base}/api/matih-embed-token`)).status, 405);
    assert.equal(calls.length, count, "no token was minted for any of them");
  });

  it("serves the page and the element, and nothing else", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<matih-embed token-endpoint="\/api\/matih-embed-token"/);
    assert.ok(!html.includes("mtk_") && !html.includes("met_"), "no credential in the page");

    const js = await fetch(`${base}/matih-embed.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  });
});

describe("when Matih refuses", () => {
  it("answers 502 with the code only, not Matih's message", async () => {
    const { mitra } = fakeMatih(() => ({
      status: 422,
      body: { detail: { category: "validation", code: "invalid_value", message: "customer_id: secret detail" } },
    }));
    const app = createApp({ mitra, resource: { type: "dashboard", id: "d_123" }, appOrigin: APP_ORIGIN, elementFile });
    const base = await start(app);
    try {
      const originalError = console.error;
      console.error = () => {};
      let res;
      try {
        res = await post(base);
      } finally {
        console.error = originalError;
      }
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: "invalid_value" });
      assert.ok(!text.includes("secret detail"));
    } finally {
      app.close();
    }
  });
});

describe("Gems embed", () => {
  it("sends no filters", async () => {
    const { calls, mitra } = fakeMatih(() => ({ status: 201, body: { ...minted, resource: { type: "gems", id: "s_1" } } }));
    const app = createApp({ mitra, resource: { type: "gems", id: "s_1" }, appOrigin: APP_ORIGIN, elementFile });
    const base = await start(app);
    try {
      assert.equal((await post(base)).status, 200);
      const sent = JSON.parse(calls[0].body);
      assert.deepEqual(sent.resource, { type: "gems", id: "s_1" });
      assert.ok(!("filters" in sent));
    } finally {
      app.close();
    }
  });
});
