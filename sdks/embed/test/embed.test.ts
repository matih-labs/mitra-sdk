// @vitest-environment jsdom
/**
 * <matih-embed> against docs/EMBEDS.md in matih-labs/mitra (branch feat/embeds), section 7:
 * token in the fragment, token-expiring answered only to the frame's exact origin, never "*".
 *
 * jsdom does not load cross-origin iframes, so each test replaces the iframe's
 * `contentWindow` with a stub that records postMessage, and delivers "messages from the frame"
 * by dispatching message events whose `source` and `origin` the test controls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatihEmbed, SANDBOX, defineMatihEmbed, parseSrc, type GetToken, type MatihErrorDetail } from "../src/index.js";

const SRC = "https://workspace.matih.ai/embed/dashboards/d_123?e=emt_Ab12";
const ORIGIN = "https://workspace.matih.ai";

interface Mounted {
  el: MatihEmbed;
  errors: MatihErrorDetail[];
  readyCount: () => number;
  win: { postMessage: ReturnType<typeof vi.fn> };
}

/** Make an element, attach it, and wait for its first load. */
async function mount(
  attrs: Record<string, string>,
  props: { getToken?: GetToken } = {},
  tag = "matih-embed",
): Promise<Mounted> {
  const el = document.createElement(tag) as MatihEmbed;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (props.getToken) el.getToken = props.getToken;
  const errors: MatihErrorDetail[] = [];
  let ready = 0;
  el.addEventListener("matih:error", (e) => errors.push((e as CustomEvent<MatihErrorDetail>).detail));
  el.addEventListener("matih:ready", () => ready++);
  document.body.appendChild(el);
  await el.updateComplete;
  const win = { postMessage: vi.fn() };
  if (el.frame) Object.defineProperty(el.frame, "contentWindow", { value: win, configurable: true });
  return { el, errors, readyCount: () => ready, win };
}

/** Deliver a message to `window` as if `source` had posted it from `origin`. */
function fire(data: unknown, origin: string, source: unknown): void {
  const e = new Event("message");
  Object.defineProperties(e, {
    data: { value: data },
    origin: { value: origin },
    source: { value: source },
  });
  window.dispatchEvent(e);
}

const settle = (ms = 15) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the iframe", () => {
  it("puts the token in the fragment only, and sandboxes and un-refers it", async () => {
    const { el } = await mount({ src: SRC, token: "met_abc" });
    const frame = el.frame!;
    const url = new URL(frame.src);
    expect(url.origin + url.pathname + url.search).toBe(SRC);
    expect(url.search).toBe("?e=emt_Ab12"); // no token in the query
    expect(url.hash).toBe("#token=met_abc");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(el.shadowRoot?.contains(frame)).toBe(true);
  });

  it("grants exactly the two sandbox flags and nothing that could navigate or open windows", () => {
    expect(SANDBOX.split(" ").sort()).toEqual(["allow-same-origin", "allow-scripts"]);
    for (const flag of ["allow-top-navigation", "allow-popups", "allow-forms", "allow-modals", "allow-downloads"]) {
      expect(SANDBOX).not.toContain(flag);
    }
  });

  it("drops a fragment left in src and uses the token attribute instead", async () => {
    const { el } = await mount({ src: `${SRC}#token=met_leaked`, token: "met_real" });
    expect(new URL(el.frame!.src).hash).toBe("#token=met_real");
  });

  it("encodes the token so it cannot add fragment fields", async () => {
    const { el } = await mount({ src: SRC, token: "met_a&b=c" });
    expect(new URL(el.frame!.src).hash).toBe("#token=met_a%26b%3Dc");
  });

  it("sizes the frame from height and title without reloading it", async () => {
    const { el } = await mount({ src: SRC, token: "met_abc" });
    const frame = el.frame!;
    expect(frame.style.height).toBe("640px");
    expect(frame.title).toBe("Matih embed");
    el.setAttribute("height", "480");
    expect(frame.style.height).toBe("480px");
    el.setAttribute("height", "75%");
    expect(frame.style.height).toBe("75%");
    el.setAttribute("height", "calc(1px)"); // not a plain length: back to the default
    expect(frame.style.height).toBe("640px");
    el.setAttribute("title", "Sales");
    expect(frame.title).toBe("Sales");
    await el.updateComplete;
    expect(el.frame).toBe(frame);
  });

  it("reloads once when src and token change together", async () => {
    const { el } = await mount({ src: SRC, token: "met_one" });
    const first = el.frame!;
    el.setAttribute("src", "https://workspace.matih.ai/embed/dashboards/d_9?e=emt_Zz9");
    el.setAttribute("token", "met_two");
    await el.updateComplete;
    expect(el.frame).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(el.shadowRoot?.querySelectorAll("iframe")).toHaveLength(1);
    expect(new URL(el.frame!.src).hash).toBe("#token=met_two");
  });

  it("removes the frame when disconnected", async () => {
    const { el } = await mount({ src: SRC, token: "met_abc" });
    el.remove();
    expect(el.frame).toBeNull();
  });
});

describe("src is validated", () => {
  it.each([
    ["http://example.com/embed/x", "plain http off localhost"],
    ["/embed/dashboards/d_123", "relative"],
    ["javascript:alert(1)", "javascript:"],
    ["https://user:pw@workspace.matih.ai/embed/x", "credentials"],
    ["not a url", "garbage"],
  ])("refuses %s (%s) with invalid_src and builds no frame", async (src) => {
    const { el, errors } = await mount({ src, token: "met_abc" });
    expect(el.frame).toBeNull();
    expect(errors).toEqual([expect.objectContaining({ code: "invalid_src", source: "element" })]);
  });

  it("allows http for localhost and 127.0.0.1", async () => {
    for (const src of ["http://localhost:8000/embed/gems/c1?e=emt_1", "http://127.0.0.1:8000/embed/gems/c1?e=emt_1"]) {
      const { el, errors } = await mount({ src, token: "met_abc" });
      expect(errors).toEqual([]);
      expect(el.frame).not.toBeNull();
    }
  });

  it("parseSrc returns null for what it refuses and a URL otherwise", () => {
    expect(parseSrc(null)).toBeNull();
    expect(parseSrc("")).toBeNull();
    expect(parseSrc("ftp://workspace.matih.ai/x")).toBeNull();
    expect(parseSrc(SRC)?.origin).toBe(ORIGIN);
  });

  it("a JWT you sign goes in the fragment like any token, and src carries only the integration id", async () => {
    const jwt = "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIn0.eyJpc3MiOiJhYmMifQ.c2ln";
    const src = "https://workspace.matih.ai/embed/dashboards/d_123?e=0123456789abcdef0123456789abcdef";
    const { el, errors } = await mount({ src, token: jwt });
    expect(errors).toEqual([]);
    const url = new URL(el.frame!.src);
    expect(url.search).toBe("?e=0123456789abcdef0123456789abcdef");
    expect(url.hash).toBe(`#token=${jwt}`);
  });

  it("refuses a src that carries a JWT in its query (personal data never goes in a URL query)", async () => {
    const jwt = "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIn0.eyJpc3MiOiJhYmMifQ.c2ln";
    expect(parseSrc(`https://workspace.matih.ai/embed/dashboards/d_123?e=${jwt}`)).toBeNull();
    expect(parseSrc(`https://workspace.matih.ai/embed/dashboards/d_123?x=1&t=${jwt}`)).toBeNull();
    const { el, errors } = await mount({ src: `https://workspace.matih.ai/embed/dashboards/d_123?e=${jwt}`, token: jwt });
    expect(errors).toEqual([expect.objectContaining({ code: "invalid_src", source: "element" })]);
    expect(el.frame).toBeNull();
  });

  it("answers a token refresh with a JWT the same way as with a met_ token", async () => {
    const jwt = "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIn0.eyJpc3MiOiJhYmMifQ.c2ln";
    const getToken = vi.fn(async () => jwt);
    const { win } = await mount({ src: SRC, token: "met_attr" }, { getToken });
    fire({ type: "matih:token-expiring", embed: "0123456789abcdef0123456789abcdef" }, ORIGIN, win);
    await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalledWith({ type: "matih:token", token: jwt }, ORIGIN));
    expect(getToken).toHaveBeenCalledWith({ embed: "0123456789abcdef0123456789abcdef" });
  });

  it("missing src and missing token are reported", async () => {
    const noSrc = await mount({ token: "met_abc" });
    expect(noSrc.errors.map((e) => e.code)).toEqual(["missing_src"]);
    const noToken = await mount({ src: SRC });
    expect(noToken.errors.map((e) => e.code)).toEqual(["missing_token"]);
    expect(noToken.el.frame).toBeNull();
  });
});

describe("getting the first token", () => {
  it("asks token-endpoint with a JSON POST and loads the src it returns", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: "met_first", src: SRC }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { el, errors } = await mount({ "token-endpoint": "/api/embed-token" });
    expect(errors).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/embed-token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
    expect(new URL(el.frame!.src).hash).toBe("#token=met_first");
    expect(new URL(el.frame!.src).search).toBe("?e=emt_Ab12");
  });

  it("an explicit src wins over one in the endpoint's answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ token: "met_t", url: "https://evil.test/x" }) })),
    );
    const { el } = await mount({ "token-endpoint": "/t", src: SRC });
    expect(new URL(el.frame!.src).origin).toBe(ORIGIN);
  });

  it("getToken may return a string or {token, src}", async () => {
    const a = await mount({ src: SRC }, { getToken: () => "met_str" });
    expect(new URL(a.el.frame!.src).hash).toBe("#token=met_str");
    const b = await mount({}, { getToken: async () => ({ token: "met_obj", src: SRC }) });
    expect(new URL(b.el.frame!.src).hash).toBe("#token=met_obj");
  });

  it("reports a failing endpoint and a bad answer as token_unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const down = await mount({ "token-endpoint": "/t", src: SRC });
    expect(down.errors).toEqual([expect.objectContaining({ code: "token_unavailable", source: "element" })]);
    expect(down.el.frame).toBeNull();

    const empty = await mount({ src: SRC }, { getToken: () => ({ nothing: true }) as never });
    expect(empty.errors.map((e) => e.code)).toEqual(["token_unavailable"]);
  });

  it("a token attribute is used for the first load; a later load takes a fresh one", async () => {
    const getToken = vi.fn(async () => "met_fresh");
    const { el } = await mount({ src: SRC, token: "met_attr" }, { getToken });
    expect(new URL(el.frame!.src).hash).toBe("#token=met_attr");
    expect(getToken).not.toHaveBeenCalled();
    el.remove();
    document.body.appendChild(el);
    await el.updateComplete;
    expect(new URL(el.frame!.src).hash).toBe("#token=met_fresh");
  });

  it("a script that sets getToken just after connecting is not reported as an error", async () => {
    const el = document.createElement("matih-embed") as MatihEmbed;
    el.setAttribute("src", SRC);
    const errors: unknown[] = [];
    el.addEventListener("matih:error", (e) => errors.push(e));
    document.body.appendChild(el);
    // Queued before the element's own one-turn grace timer, so it runs first.
    setTimeout(() => {
      el.getToken = () => "met_late";
    }, 0);
    await el.updateComplete;
    expect(errors).toEqual([]);
    expect(new URL(el.frame!.src).hash).toBe("#token=met_late");
  });

  it("getToken set after the missing_token error loads the frame", async () => {
    const { el, errors } = await mount({ src: SRC });
    expect(errors.map((e) => e.code)).toEqual(["missing_token"]);
    el.getToken = () => "met_later";
    await el.updateComplete;
    expect(new URL(el.frame!.src).hash).toBe("#token=met_later");
  });

  it("keeps a getToken assigned before the element was defined", async () => {
    const el = document.createElement("matih-embed-late") as MatihEmbed; // not defined yet
    el.setAttribute("src", SRC);
    (el as unknown as { getToken: GetToken }).getToken = () => "met_early";
    document.body.appendChild(el);
    defineMatihEmbed("matih-embed-late"); // upgrades it
    await el.updateComplete;
    expect(new URL(el.frame!.src).hash).toBe("#token=met_early");
  });
});

describe("token refresh (matih:token-expiring)", () => {
  it("answers {type:'matih:token', token} to the frame's exact origin, never '*'", async () => {
    const getToken = vi.fn(async () => "met_new");
    const { el, win } = await mount({ src: SRC, token: "met_old" }, { getToken });
    fire({ type: "matih:token-expiring", embed: "emt_Ab12" }, ORIGIN, win);
    await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalledTimes(1));
    expect(win.postMessage).toHaveBeenCalledWith({ type: "matih:token", token: "met_new" }, ORIGIN);
    expect(win.postMessage.mock.calls.map((c) => c[1])).not.toContain("*");
    expect(getToken).toHaveBeenCalledWith({ embed: "emt_Ab12" });
    expect(el.frame).not.toBeNull(); // the document is not reloaded
  });

  it("asks token-endpoint with the embed id when there is no getToken", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ token: "met_via_endpoint" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const { win } = await mount({ src: SRC, token: "met_old", "token-endpoint": "/api/embed-token" });
    fire({ type: "matih:token-expiring", embed: "emt_Ab12" }, ORIGIN, win);
    await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ embed: "emt_Ab12" });
    expect(win.postMessage).toHaveBeenCalledWith({ type: "matih:token", token: "met_via_endpoint" }, ORIGIN);
  });

  it("posts to the origin of its own src, wherever that is", async () => {
    const src = "https://embed.customer-eu.example:8443/embed/dashboards/d_1?e=emt_9";
    const { win } = await mount({ src, token: "met_old" }, { getToken: () => "met_new" });
    fire({ type: "matih:token-expiring" }, "https://embed.customer-eu.example:8443", win);
    await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalled());
    expect(win.postMessage.mock.calls[0]![1]).toBe("https://embed.customer-eu.example:8443");
  });

  it("ignores messages from another origin, another window, or in another shape", async () => {
    const getToken = vi.fn(async () => "met_new");
    const { win } = await mount({ src: SRC, token: "met_old" }, { getToken });
    const expiring = { type: "matih:token-expiring", embed: "emt_Ab12" };
    fire(expiring, "https://evil.example", win); // right window, wrong origin
    fire(expiring, ORIGIN, { postMessage: vi.fn() }); // right origin, some other window
    fire(expiring, ORIGIN, window); // the page itself
    fire(expiring, ORIGIN, null);
    fire("matih:token-expiring", ORIGIN, win); // not an object
    fire(null, ORIGIN, win);
    fire({ type: 42 }, ORIGIN, win);
    fire({ type: "something-else" }, ORIGIN, win);
    await settle();
    expect(getToken).not.toHaveBeenCalled();
    expect(win.postMessage).not.toHaveBeenCalled();
  });

  it("answers a burst of expiring messages with one mint and one reply", async () => {
    let release: (t: string) => void = () => undefined;
    const getToken = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const { win } = await mount({ src: SRC, token: "met_old" }, { getToken });
    for (let i = 0; i < 3; i++) fire({ type: "matih:token-expiring", embed: "emt_Ab12" }, ORIGIN, win);
    await vi.waitFor(() => expect(getToken).toHaveBeenCalled());
    release("met_new");
    await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalled());
    await settle();
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
  });

  it("can refresh again after a refresh finished", async () => {
    let n = 0;
    const getToken = vi.fn(async () => `met_${++n}`);
    const { win } = await mount({ src: SRC, token: "met_old" }, { getToken });
    fire({ type: "matih:token-expiring" }, ORIGIN, win);
    await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalledTimes(1));
    fire({ type: "matih:token-expiring" }, ORIGIN, win);
    await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalledTimes(2));
    expect(win.postMessage.mock.calls.map((c) => (c[0] as { token: string }).token)).toEqual(["met_1", "met_2"]);
  });

  it("sends nothing and reports token_unavailable when the mint fails", async () => {
    const { win, errors } = await mount(
      { src: SRC, token: "met_old" },
      {
        getToken: async () => {
          throw new Error("backend said no");
        },
      },
    );
    fire({ type: "matih:token-expiring" }, ORIGIN, win);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ code: "token_unavailable", message: "backend said no", source: "element" });
    expect(win.postMessage).not.toHaveBeenCalled();
  });

  it("reports no_token_provider when the frame asks and nothing can answer", async () => {
    const { win, errors } = await mount({ src: SRC, token: "met_old" });
    fire({ type: "matih:token-expiring" }, ORIGIN, win);
    await vi.waitFor(() => expect(errors.map((e) => e.code)).toContain("no_token_provider"));
    expect(win.postMessage).not.toHaveBeenCalled();
  });

  it("does not post a token to a frame that was removed while the mint was running", async () => {
    let release: (t: string) => void = () => undefined;
    const getToken = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const { el, win } = await mount({ src: SRC, token: "met_old" }, { getToken });
    fire({ type: "matih:token-expiring" }, ORIGIN, win);
    await vi.waitFor(() => expect(getToken).toHaveBeenCalled());
    el.remove();
    release("met_new");
    await settle();
    expect(win.postMessage).not.toHaveBeenCalled();
  });

  it("stops listening once disconnected", async () => {
    const getToken = vi.fn(async () => "met_new");
    const { el, win } = await mount({ src: SRC, token: "met_old" }, { getToken });
    el.remove();
    fire({ type: "matih:token-expiring" }, ORIGIN, win);
    await settle();
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe("matih:resize", () => {
  it("takes the frame's height, rounded up, over the height attribute", async () => {
    const { el, win } = await mount({ src: SRC, token: "met_abc", height: "300" });
    expect(el.frame!.style.height).toBe("300px");
    fire({ type: "matih:resize", height: 812.4 }, ORIGIN, win);
    expect(el.frame!.style.height).toBe("813px");
    fire({ type: "matih:resize", height: 500 }, ORIGIN, win);
    expect(el.frame!.style.height).toBe("500px");
  });

  it("is capped, and only a positive finite number counts", async () => {
    const { el, win } = await mount({ src: SRC, token: "met_abc", height: "300" });
    fire({ type: "matih:resize", height: 1e9 }, ORIGIN, win);
    expect(el.frame!.style.height).toBe("20000px");
    fire({ type: "matih:resize", height: 400 }, ORIGIN, win);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "900", "9px", null, {}, [700]]) {
      fire({ type: "matih:resize", height: bad }, ORIGIN, win);
      expect(el.frame!.style.height).toBe("400px");
    }
  });

  it("is ignored from another origin or another window", async () => {
    const { el, win } = await mount({ src: SRC, token: "met_abc", height: "300" });
    fire({ type: "matih:resize", height: 900 }, "https://evil.example", win);
    fire({ type: "matih:resize", height: 900 }, ORIGIN, { postMessage: vi.fn() });
    fire({ type: "matih:resize", height: 900 }, ORIGIN, window);
    expect(el.frame!.style.height).toBe("300px");
  });

  it("gives way to a new height attribute, and starts over on a reload", async () => {
    const { el, win } = await mount({ src: SRC, token: "met_abc", height: "300" });
    fire({ type: "matih:resize", height: 900 }, ORIGIN, win);
    el.setAttribute("height", "350");
    expect(el.frame!.style.height).toBe("350px");
    fire({ type: "matih:resize", height: 900 }, ORIGIN, win);
    el.setAttribute("token", "met_two"); // reloads the frame
    await el.updateComplete;
    expect(el.frame!.style.height).toBe("350px");
  });

  it("survives a title change", async () => {
    const { el, win } = await mount({ src: SRC, token: "met_abc" });
    fire({ type: "matih:resize", height: 900 }, ORIGIN, win);
    el.setAttribute("title", "Sales");
    expect(el.frame!.style.height).toBe("900px");
  });
});

describe("events", () => {
  it("emits matih:ready when the frame says so, and the event bubbles out of the shadow root", async () => {
    const { win, readyCount } = await mount({ src: SRC, token: "met_abc" });
    const seen = vi.fn();
    document.body.addEventListener("matih:ready", seen);
    fire({ type: "matih:ready" }, ORIGIN, win);
    expect(readyCount()).toBe(1);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("emits matih:error with the frame's code, and bounds what it passes on", async () => {
    const { win, errors } = await mount({ src: SRC, token: "met_abc" });
    fire({ type: "matih:error", code: "expired", detail: "ignored" }, ORIGIN, win);
    fire({ type: "matih:error", code: 5 }, ORIGIN, win);
    fire({ type: "matih:error", code: "x".repeat(500) }, ORIGIN, win);
    expect(errors[0]).toEqual({ code: "expired", source: "frame" });
    expect(errors[1]).toEqual({ code: "unknown", source: "frame" });
    expect(errors[2]?.code).toHaveLength(64);
  });

  it("does not emit frame events for a message from anywhere else", async () => {
    const { win, errors, readyCount } = await mount({ src: SRC, token: "met_abc" });
    fire({ type: "matih:ready" }, "https://evil.example", win);
    fire({ type: "matih:error", code: "spoof" }, ORIGIN, { postMessage: vi.fn() });
    expect(readyCount()).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("registration", () => {
  it("registers <matih-embed> on import and is safe to call again", () => {
    expect(customElements.get("matih-embed")).toBe(MatihEmbed);
    expect(() => defineMatihEmbed()).not.toThrow();
  });
});
