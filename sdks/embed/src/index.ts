/**
 * `<matih-embed>`: a Matih dashboard, Gems feed or Ask box in an iframe.
 *
 * Contract: docs/EMBEDS.md in matih-labs/mitra, sections 3.1 (mint), 7 (browser protocol) and 14 (the Ask embed).
 *
 *   iframe URL            {src}#token={token}        the token is only ever in the fragment
 *   iframe -> parent      {type:"matih:token-expiring", embed:"emt_..."}   (the integration id for a JWT you sign)
 *   parent -> iframe      {type:"matih:token", token:"met_..."}   posted to the frame's exact origin
 *
 * The token is a `met_...` secret from a mint, or the compact JWT your backend signed for its viewer:
 * the element treats both alike and never looks inside. A JWT carries the viewer's email, phone and
 * attributes, so it is never in a URL query (access logs, Referer, history): `src` carries only
 * `?e=<emt_ id or integration id>`, and `src` with a JWT in its query is refused (`invalid_src`).
 *   iframe -> parent      {type:"matih:ready"} and {type:"matih:error", code}   (optional)
 *   iframe -> parent      {type:"matih:resize", height:<px>}   the frame's content height
 *
 * No runtime dependencies, no build-time globals: importing this module on a server (no
 * `HTMLElement`) does nothing, and in a browser it registers `<matih-embed>`.
 */

/** What a token provider may return: the token alone, or the token and the page to load. */
export type TokenResult = string | { token: string; src?: string; url?: string };

/** What `getToken` is told. `embed` is the id the embed page reports (the `emt_...` id of the token that is about to expire). */
export interface TokenRequest {
  embed?: string;
}

export type GetToken = (request: TokenRequest) => TokenResult | Promise<TokenResult>;

export interface MatihErrorDetail {
  /**
   * `missing_src`, `invalid_src`, `missing_token`, `no_token_provider`, `token_unavailable`,
   * or the `code` the embed page itself reported (the `matih:error` message, source `frame`).
   */
  code: string;
  message?: string;
  source: "element" | "frame";
}

/** Sandbox flags, and why each is there. Nothing else is granted (no popups, forms, top navigation). */
export const SANDBOX = "allow-scripts allow-same-origin";

/** How long to wait for the customer's backend (or `getToken`) to hand over a fresh token. */
export const TOKEN_TIMEOUT_MS = 15_000;

const DEFAULT_HEIGHT = "640px";
/** An Ask box is a field and, once asked, an answer: it starts short and follows its own `matih:resize`. */
const DEFAULT_ASK_HEIGHT = "280px";
/** The Ask page shows at most this many suggestion chips (the page clips the same way; sending more would only lengthen the URL). */
const MAX_ASK_SUGGESTIONS = 3;
/** A frame cannot ask for more than this: a bad or hostile height must not make the page unusable. */
const MAX_FRAME_HEIGHT_PX = 20_000;

const HostBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1";
}

/**
 * The embed page URL, or null when it must not be framed: not absolute, not https (plain http
 * only for localhost and 127.0.0.1, as the origins rule in the contract), or with credentials.
 * Any fragment is dropped: the token is added by the element, not taken from the page's markup.
 * A query value that is a JWT (`eyJ...`) is refused: a viewer token never goes in a URL query.
 */
export function parseSrc(value: string | null | undefined): URL | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
  if (!secure || url.username !== "" || url.password !== "") return null;
  for (const value of url.searchParams.values()) if (looksLikeJwt(value)) return null;
  return url;
}

/** A compact JWS: base64url segments, the first a JSON header (`{"` is `eyJ`). */
function looksLikeJwt(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*$/.test(value);
}

function cssLength(value: string | null, fallback: string = DEFAULT_HEIGHT): string {
  if (value === null) return fallback;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return `${v}px`;
  if (/^\d+(\.\d+)?(px|vh|rem|em|%)$/.test(v)) return v;
  return fallback;
}

/** What the Ask page reads from its address (`theme`, `accent`, `font`, `heading`, `placeholder`, `suggestions`). */
export interface AskOptions {
  /** `light`, `dark` or `auto` (the visitor's own setting, the default). */
  theme?: "light" | "dark" | "auto";
  /** A hex colour, `#2750cc` or `2750cc` or `#25c`. It colours the send button, the focus ring and the chart's lead colour, nothing else. */
  accent?: string;
  /** A plain font stack, e.g. `Georgia, serif`. No URLs and no punctuation beyond `, ' " -`. */
  font?: string;
  /** The line above the field. */
  heading?: string;
  /** The field's placeholder. */
  placeholder?: string;
  /** Up to three questions to offer, as chips. In an attribute they are separated by `|`. */
  suggestions?: string[] | string;
}

const HEX_COLOUR = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
const FONT_STACK = /^[\w ,'"-]{1,80}$/;

const oneLine = (value: string | null | undefined, max: number): string => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The Ask page's options as query parameters, each held to what the page accepts: a colour is a hex colour, a font a plain
 * stack, the texts short, at most three suggestions. What does not fit is left out, so the page shows its own default.
 */
export function askParams(options: AskOptions): URLSearchParams {
  const out = new URLSearchParams();
  if (options.theme === "light" || options.theme === "dark") out.set("theme", options.theme);
  const colour = HEX_COLOUR.exec((options.accent ?? "").trim());
  if (colour?.[1]) out.set("accent", colour[1].toLowerCase());
  const font = (options.font ?? "").trim();
  if (FONT_STACK.test(font)) out.set("font", font);
  const heading = oneLine(options.heading, 80);
  if (heading) out.set("heading", heading);
  const placeholder = oneLine(options.placeholder, 100);
  if (placeholder) out.set("placeholder", placeholder);
  const raw = typeof options.suggestions === "string" ? options.suggestions.split("|") : (options.suggestions ?? []);
  // `|` separates them in the address, so one cannot hold a `|` of its own.
  const suggestions = raw.map((s) => oneLine(s.replace(/\|/g, " "), 120)).filter((s) => s !== "").slice(0, MAX_ASK_SUGGESTIONS);
  if (suggestions.length > 0) out.set("suggestions", suggestions.join("|"));
  return out;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no token after ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** `{token, src?}` from a provider's answer, or an Error saying what was wrong with it. */
function readTokenResult(result: unknown): { token: string; src: string | undefined } {
  if (typeof result === "string" && result !== "") return { token: result, src: undefined };
  if (isRecord(result) && typeof result["token"] === "string" && result["token"] !== "") {
    const page = result["src"] ?? result["url"];
    return { token: result["token"], src: typeof page === "string" ? page : undefined };
  }
  throw new Error("the token provider did not return a token");
}

const STYLE = `
:host { display: block; width: 100%; }
:host([hidden]) { display: none; }
iframe { display: block; width: 100%; border: 0; }
`;

export class MatihEmbed extends HostBase {
  static get observedAttributes(): string[] {
    return ["src", "token", "token-endpoint", "height", "title", "kind", "theme", "accent", "font", "heading", "placeholder", "suggestions"];
  }

  private provider: GetToken | undefined;
  private starved = false;
  private frameEl: HTMLIFrameElement | null = null;
  private frameOrigin = "";
  private generation = 0;
  private scheduled = false;
  private connected = false;
  private attrTokenUsed = false;
  /** Height the embed page asked for with `matih:resize`; null until it does. */
  private resizedPx: number | null = null;
  private refreshing: Promise<void> | null = null;
  private done: Promise<void> = Promise.resolve();
  private readonly onMessage = (event: Event): void => this.handleMessage(event as MessageEvent);

  /**
   * Called to get a fresh token when the embed page says its token is expiring (and for the
   * first load when there is no `token` attribute). Takes precedence over `token-endpoint`.
   * Mint on your backend with `POST /api/v1/embeds`; never in the browser.
   */
  get getToken(): GetToken | undefined {
    return this.provider;
  }

  set getToken(fn: GetToken | undefined) {
    this.provider = fn;
    // A load that found nothing to ask for can go ahead now.
    if (fn && this.starved) {
      this.starved = false;
      this.schedule();
    }
  }

  /** `ask` for an Ask box (its options are then read from the attributes), anything else for a dashboard or Gems feed. */
  private isAsk(): boolean {
    return this.getAttribute("kind") === "ask";
  }

  /** The iframe, once it exists. */
  get frame(): HTMLIFrameElement | null {
    return this.frameEl;
  }

  /** Resolves when the iframe for the current attributes has been created (or refused, with `matih:error`). */
  get updateComplete(): Promise<void> {
    return this.done;
  }

  connectedCallback(): void {
    // `getToken` assigned before this element was defined is an own property that would shadow
    // the accessor above: put it back through the setter.
    if (Object.prototype.hasOwnProperty.call(this, "getToken")) {
      const early = (this as unknown as { getToken: GetToken | undefined }).getToken;
      delete (this as unknown as { getToken?: GetToken }).getToken;
      this.getToken = early;
    }
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      root.appendChild(style);
    }
    this.connected = true;
    window.addEventListener("message", this.onMessage);
    this.schedule();
  }

  disconnectedCallback(): void {
    this.connected = false;
    window.removeEventListener("message", this.onMessage);
    this.generation++;
    this.removeFrame();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === "token") this.attrTokenUsed = false;
    if (name === "height" || name === "title") {
      // The author changing `height` wins over what the frame last asked for.
      if (name === "height") this.resizedPx = null;
      this.applyFrameAttributes();
      return;
    }
    this.schedule();
  }

  // ---------------------------------------------------------------- loading

  /** Coalesce attribute changes made in one go into a single (re)load. */
  private schedule(): void {
    if (!this.connected || this.scheduled) return;
    this.scheduled = true;
    this.done = Promise.resolve().then(() => {
      this.scheduled = false;
      return this.load();
    });
  }

  private hasProvider(): boolean {
    return typeof this.provider === "function" || !!this.getAttribute("token-endpoint");
  }

  private async load(): Promise<void> {
    if (!this.connected) return;
    const gen = ++this.generation;
    this.removeFrame();

    let srcValue = this.getAttribute("src");
    let token = this.getAttribute("token") || "";

    // The `token` attribute belongs to the `src` it was minted with and is used for the first
    // load. A later load (moved in the DOM, `src` changed) takes a fresh token if it can.
    if (token !== "" && this.attrTokenUsed && this.hasProvider()) token = "";

    if (token === "") {
      if (!this.hasProvider()) {
        // A script that sets `getToken` may run just after this element connects: give it one turn.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (gen !== this.generation) return;
      }
      if (!this.hasProvider()) {
        this.starved = true;
        this.fail("missing_token", "set the token attribute, the token-endpoint attribute or the getToken property");
        return;
      }
      this.starved = false;
      try {
        const got = await this.fetchToken({});
        token = got.token;
        if (!srcValue && got.src) srcValue = got.src;
      } catch (err) {
        if (gen === this.generation) this.fail("token_unavailable", err instanceof Error ? err.message : String(err));
        return;
      }
      if (gen !== this.generation) return; // attributes changed, or disconnected, while waiting
    } else {
      this.attrTokenUsed = true;
    }

    if (!srcValue) {
      this.fail("missing_src", "set the src attribute to the url from the mint response, without its #token (or, for a token you sign, the page URL with ?e=<integration id>)");
      return;
    }
    const page = parseSrc(srcValue);
    if (!page) {
      this.fail("invalid_src", "src must be an absolute https URL (http only for localhost and 127.0.0.1), with no token in its query");
      return;
    }

    // The token goes in the fragment only: it is not sent to any server, not in the Referer,
    // not in logs. The embed page reads it and removes it from the address.
    // An Ask box's options are its attributes, in the query (they are not secret; the viewer's token is never there).
    if (this.isAsk()) {
      const options = askParams({
        theme: (this.getAttribute("theme") ?? undefined) as AskOptions["theme"],
        accent: this.getAttribute("accent") ?? undefined,
        font: this.getAttribute("font") ?? undefined,
        heading: this.getAttribute("heading") ?? undefined,
        placeholder: this.getAttribute("placeholder") ?? undefined,
        suggestions: this.getAttribute("suggestions") ?? undefined,
      });
      for (const [key, value] of options) page.searchParams.set(key, value);
    }
    page.hash = new URLSearchParams({ token }).toString();
    this.frameOrigin = page.origin;

    const iframe = document.createElement("iframe");
    // Both flags are needed, and nothing else:
    //  - allow-scripts: the embed page is a script-driven app.
    //  - allow-same-origin: without it the frame is an opaque origin and its messages arrive with
    //    origin "null". The contract forbids posting to "*", and an opaque origin can only be
    //    addressed with "*", so the token refresh handshake could not be pinned to an origin.
    //    It is also what lets the page call its own /api/embed/* with fetch and clear its hash.
    //  The combination is safe here because the frame is on Matih's origin, not the embedding
    //  page's; it would defeat the sandbox only for a frame served from the same origin as the parent.
    //  Not granted: popups, forms, top-navigation, downloads, modals.
    iframe.setAttribute("sandbox", SANDBOX);
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("loading", "lazy");
    this.frameEl = iframe;
    this.applyFrameAttributes();
    iframe.src = page.toString();
    this.shadowRoot?.appendChild(iframe);
  }

  private removeFrame(): void {
    this.frameEl?.remove();
    this.frameEl = null;
    this.frameOrigin = "";
    this.refreshing = null;
    this.resizedPx = null;
  }

  private applyFrameAttributes(): void {
    const iframe = this.frameEl;
    if (!iframe) return;
    // `height` is the initial and fallback height; the frame's own `matih:resize` takes over from it.
    const ask = this.isAsk();
    iframe.style.height = this.resizedPx === null ? cssLength(this.getAttribute("height"), ask ? DEFAULT_ASK_HEIGHT : DEFAULT_HEIGHT) : `${this.resizedPx}px`;
    iframe.title = this.getAttribute("title") || (ask ? "Ask Matih" : "Matih embed");
  }

  // ---------------------------------------------------------------- tokens

  /** Ask `getToken`, else the customer's `token-endpoint`. */
  private async fetchToken(request: TokenRequest): Promise<{ token: string; src: string | undefined }> {
    const provider = this.provider;
    if (typeof provider === "function") {
      return readTokenResult(await withTimeout(Promise.resolve().then(() => provider(request)), TOKEN_TIMEOUT_MS));
    }
    const endpoint = this.getAttribute("token-endpoint");
    if (!endpoint) throw new Error("no token provider");
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    try {
      // POST with a JSON body: a cross-site page cannot make this request without a CORS
      // preflight your backend has not allowed, so it cannot mint tokens on your viewer's behalf.
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`token-endpoint answered HTTP ${res.status}`);
      return readTokenResult(await res.json());
    } finally {
      clearTimeout(abort);
    }
  }

  /** Answer one `matih:token-expiring`. Concurrent requests share one mint. */
  private refresh(embed: string | undefined): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const frame = this.frameEl;
    const origin = this.frameOrigin;
    if (!frame) return Promise.resolve();
    if (!this.hasProvider()) {
      this.fail("no_token_provider", "the embed asked for a new token and neither getToken nor token-endpoint is set");
      return Promise.resolve();
    }
    const work = (async (): Promise<void> => {
      try {
        const { token } = await this.fetchToken(embed === undefined ? {} : { embed });
        // Post only if this is still the same frame (not reloaded, moved or removed meanwhile).
        const target = this.frameEl === frame ? frame.contentWindow : null;
        if (target && this.frameOrigin === origin) {
          target.postMessage({ type: "matih:token", token }, origin);
        }
      } catch (err) {
        if (this.frameEl === frame) {
          this.fail("token_unavailable", err instanceof Error ? err.message : String(err));
        }
      }
    })().finally(() => {
      // Runs after `refreshing` is set below: a finally callback is always asynchronous.
      if (this.refreshing === work) this.refreshing = null;
    });
    this.refreshing = work;
    return work;
  }

  // ---------------------------------------------------------------- messages from the frame

  private handleMessage(event: MessageEvent): void {
    const frame = this.frameEl;
    // Only the frame we made, and only from the origin we loaded it from. Anything else on
    // `window` (other frames, extensions, the page itself) is ignored.
    if (!frame || !frame.contentWindow) return;
    if (event.source !== frame.contentWindow || event.origin !== this.frameOrigin) return;
    const data: unknown = event.data;
    if (!isRecord(data) || typeof data["type"] !== "string") return;

    switch (data["type"]) {
      case "matih:token-expiring": {
        const embed = data["embed"];
        void this.refresh(typeof embed === "string" ? embed : undefined);
        break;
      }
      case "matih:resize": {
        // Only from the frame we made, at its origin (checked above). Only a plain, bounded number.
        const h = data["height"];
        if (typeof h === "number" && Number.isFinite(h) && h > 0) {
          this.resizedPx = Math.min(Math.ceil(h), MAX_FRAME_HEIGHT_PX);
          this.applyFrameAttributes();
        }
        break;
      }
      case "matih:ready":
        this.dispatchEvent(new CustomEvent("matih:ready", { bubbles: true, composed: true }));
        break;
      case "matih:error": {
        const code = typeof data["code"] === "string" && data["code"] !== "" ? data["code"].slice(0, 64) : "unknown";
        this.emitError({ code, source: "frame" });
        break;
      }
      default:
        break;
    }
  }

  private fail(code: string, message: string): void {
    this.emitError({ code, message, source: "element" });
  }

  private emitError(detail: MatihErrorDetail): void {
    this.dispatchEvent(new CustomEvent<MatihErrorDetail>("matih:error", { bubbles: true, composed: true, detail }));
  }
}

/** What `mountAsk` takes: the token provider and the Ask box's options. */
export interface MountAskOptions extends AskOptions {
  /** Mint on your backend with `POST /api/v1/embeds` (`resource: {type: "ask", id: <source id>}`) and return `{token, src}`. */
  getToken: GetToken;
  /** The page, if `getToken` does not return it: the mint response's `url` without its `#token`. */
  src?: string;
  /** Initial and fallback height, as the `height` attribute. Default `280px`; the frame follows its content from there. */
  height?: string | number;
  /** Accessible title of the frame. Default `Ask Matih`. */
  title?: string;
}

/**
 * Put an Ask box in `container`: a `<matih-embed kind="ask">` with the options as attributes and `getToken` as its provider.
 * Returns the element (remove it to take the box away); calling it again replaces what was mounted.
 */
export function mountAsk(container: Element, options: MountAskOptions): MatihEmbed {
  defineMatihEmbed();
  const el = document.createElement("matih-embed") as MatihEmbed;
  el.setAttribute("kind", "ask");
  const attrs: [string, string | undefined][] = [
    ["src", options.src],
    ["theme", options.theme],
    ["accent", options.accent],
    ["font", options.font],
    ["heading", options.heading],
    ["placeholder", options.placeholder],
    ["suggestions", Array.isArray(options.suggestions) ? options.suggestions.join("|") : options.suggestions],
    ["height", options.height === undefined ? undefined : String(options.height)],
    ["title", options.title],
  ];
  for (const [name, value] of attrs) if (value !== undefined) el.setAttribute(name, value);
  el.getToken = options.getToken;
  container.replaceChildren(el);
  return el;
}

/**
 * Register the element. Done for you on import as `<matih-embed>`; call it to use another tag
 * name too (a constructor can be registered once, so another name gets a subclass).
 */
export function defineMatihEmbed(tag = "matih-embed"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  customElements.define(tag, tag === "matih-embed" ? MatihEmbed : class extends MatihEmbed {});
}

defineMatihEmbed();

declare global {
  interface HTMLElementTagNameMap {
    "matih-embed": MatihEmbed;
  }
  interface HTMLElementEventMap {
    "matih:ready": CustomEvent<undefined>;
    "matih:error": CustomEvent<MatihErrorDetail>;
  }
}
