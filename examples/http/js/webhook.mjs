// Matih webhook signature verification: Node.js (node:crypto, node:http). No dependencies.
//
// Run the demo server (Node 18 or newer):
//   export MATIH_WEBHOOK_SECRET=whsec_...
//   node webhook.mjs            # listens on :8080, POST /matih/webhook
//   PORT=9000 node webhook.mjs
//
// Every delivery carries three headers:
//   Matih-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">
//   Matih-Event:     the event name, for example gems.ready
//   Matih-Delivery:  a unique delivery id, handy for de-duplicating retries
//
// Rules implemented below:
//   1. Sign the RAW request bytes, not re-serialised JSON.
//   2. Reject when |now - t| > 300 seconds (replay protection).
//   3. The header may carry several v1 values; any one matching is enough.
//   4. Compare with a constant-time function.
//
// The whole secret string is used as the HMAC key, including the whsec_ prefix.
// Teaching example. Do not commit your webhook secret.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const TOLERANCE_SECONDS = 300;
const MAX_BODY_BYTES = 1024 * 1024;

// Returns { ok: true } or { ok: false, reason }.
// rawBody must be a Buffer holding the exact bytes that were received.
export function verifySignature(secret, header, rawBody, nowMs = Date.now()) {
  if (typeof header !== "string" || header === "") {
    return { ok: false, reason: "missing Matih-Signature header" };
  }
  let t = null;
  const candidates = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    else if (key === "v1") candidates.push(value);
  }
  if (t === null || !/^\d+$/.test(t) || candidates.length === 0) {
    return { ok: false, reason: "malformed Matih-Signature header" };
  }
  if (Math.abs(nowMs / 1000 - Number(t)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside the 300 second tolerance" };
  }

  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  let matched = false;
  for (const hex of candidates) {
    // timingSafeEqual throws on different lengths, so check shape first.
    if (hex.length !== expected.length * 2 || !/^[0-9a-fA-F]+$/.test(hex)) continue;
    if (timingSafeEqual(Buffer.from(hex, "hex"), expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "no matching v1 signature" };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createWebhookServer(secret) {
  return createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/matih/webhook") {
      res.writeHead(404).end();
      return;
    }
    let raw;
    try {
      raw = await readRawBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    const verdict = verifySignature(secret, req.headers["matih-signature"], raw);
    if (!verdict.ok) {
      console.error(`rejected delivery: ${verdict.reason}`);
      res.writeHead(401).end();
      return;
    }
    // Only parse the JSON after the signature checked out.
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    console.log(
      `event=${req.headers["matih-event"]} delivery=${req.headers["matih-delivery"]} ` +
        `keys=${Object.keys(event).join(",")}`,
    );
    // Answer 2xx quickly and do slow work elsewhere. Retries reuse Matih-Delivery.
    res.writeHead(204).end();
  });
}

// Start the server only when this file is run directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.MATIH_WEBHOOK_SECRET;
  if (!secret) {
    console.error("MATIH_WEBHOOK_SECRET is required");
    process.exit(2);
  }
  const port = Number(process.env.PORT || 8080);
  createWebhookServer(secret).listen(port, () => {
    console.log(`listening on :${port}, POST /matih/webhook`);
  });
}
