/**
 * Mint Matih embed tokens on your backend and serve a page that shows them with <matih-embed>.
 *
 * Plain node:http, no framework. The API key stays in this process; the browser only ever gets
 * a short-lived token (valid for one resource, the filters you chose, and your page's origin).
 *
 *   MATIH_API_KEY=mtk_... EMBED_RESOURCE_ID=d_123 node server.mjs
 *
 * Then open http://localhost:3000.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EmbedNotFoundError, EmbedRefusedError, Mitra, MitraError, embedSrc } from "@matihlabs/mitra";

const MAX_BODY = 4096;

/**
 * Who is looking at the page, and which rows they may see. REPLACE THIS with your own session
 * lookup (cookie, JWT, ...). The filters come from your session, never from the request body:
 * a viewer must not be able to choose the rows they are shown.
 */
export function viewerFor(_req) {
  return { customerId: "C123" };
}

/**
 * @param {object} options
 * @param {Mitra} options.mitra               SDK client (holds the API key)
 * @param {{type: "dashboard" | "gems", id: string}} options.resource
 * @param {string} options.appOrigin          exact origin of the page that holds <matih-embed>
 * @param {string} [options.filterParam]      the dashboard's embed parameter the viewer is filtered on
 * @param {string} [options.elementFile]      file served as /matih-embed.js
 */
export function createApp({ mitra, resource, appOrigin, filterParam = "customer_id", elementFile }) {
  const element = elementFile ?? fileURLToPath(import.meta.resolve("@matihlabs/embed"));

  /** Mint one token for the viewer; the answer for <matih-embed>'s token-endpoint. */
  async function mint(req) {
    const viewer = viewerFor(req);
    const embed = await mitra.embeds.create({
      resource,
      // Gems cannot be filtered: send filters only for a dashboard.
      ...(resource.type === "dashboard" ? { filters: { [filterParam]: viewer.customerId } } : {}),
      origins: [appOrigin], // only this page may frame the embed
      ttlSeconds: 300, // a token is never renewed: the element asks for a new one before it expires
    });
    // Do not log `embed`: the token is a secret. Send the browser the token and the page it is for.
    return { token: embed.token, src: embedSrc(embed) };
  }

  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? "/", appOrigin);

      if (pathname === "/api/matih-embed-token") {
        if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
        // The element sends JSON; a cross-site form post cannot, and a cross-site fetch is held by CORS.
        // Checking both keeps another site from minting tokens with your visitor's session.
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(res, 415, { error: "json_required" });
        }
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== appOrigin) return send(res, 403, { error: "bad_origin" });
        await readBody(req); // {} first, {"embed":"emt_..."} on a refresh; nothing in it is trusted
        try {
          return send(res, 200, await mint(req), { "Cache-Control": "no-store" });
        } catch (err) {
          return sendMintError(res, err);
        }
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method_not_allowed" });
      if (pathname === "/" || pathname === "/index.html") {
        return sendFile(res, req, fileURLToPath(new URL("public/index.html", import.meta.url)), "text/html; charset=utf-8");
      }
      if (pathname === "/matih-embed.js") return sendFile(res, req, element, "text/javascript; charset=utf-8", true);
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      console.error("request failed:", err instanceof Error ? err.message : err);
      return send(res, 500, { error: "server_error" });
    }
  });
}

function sendMintError(res, err) {
  // Log what you need, send the browser little. `code` and `message` here are Matih's, not secrets.
  if (err instanceof EmbedRefusedError) {
    console.error(`embed refused: ${err.code ?? "422"}: ${err.message}`);
    return send(res, 502, { error: err.code ?? "refused" });
  }
  if (err instanceof EmbedNotFoundError) {
    console.error(`embed resource not found: ${err.message}`);
    return send(res, 502, { error: "resource_not_found" });
  }
  if (err instanceof MitraError) {
    console.error(`mint failed: HTTP ${err.status} ${err.category}: ${err.message}`);
    return send(res, 502, { error: "mint_failed" });
  }
  throw err;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

async function sendFile(res, req, file, type, cache = false) {
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache ? "public, max-age=300" : "no-cache" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    send(res, 404, { error: "not_found" });
  }
}

async function readBody(req) {
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("request body too large");
  }
}

function fromEnv(env) {
  const type = env.EMBED_RESOURCE_TYPE ?? "dashboard";
  const id = env.EMBED_RESOURCE_ID;
  if (!env.MATIH_API_KEY || !id || (type !== "dashboard" && type !== "gems")) {
    console.error(
      "Set MATIH_API_KEY (a key with the embeds:create scope), EMBED_RESOURCE_ID (a dashboard id, or a\n" +
        "source id with EMBED_RESOURCE_TYPE=gems) and, optionally, APP_ORIGIN (default http://localhost:3000).",
    );
    process.exit(1);
  }
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    mitra: new Mitra({ apiKey: env.MATIH_API_KEY }), // MATIH_BASE_URL is read by the SDK too
    resource: { type, id },
    appOrigin: env.APP_ORIGIN ?? `http://localhost:${port}`,
    filterParam: env.EMBED_FILTER_PARAM ?? "customer_id",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port, ...config } = fromEnv(process.env);
  createApp(config).listen(port, () => console.log(`open ${config.appOrigin}`));
}
