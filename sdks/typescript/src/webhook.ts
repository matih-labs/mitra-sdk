import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookBody = string | Uint8Array;

function signatureHex(secret: string, timestamp: string, body: WebhookBody): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.`);
  mac.update(body);
  return mac.digest("hex");
}

/**
 * Build a `Matih-Signature` header value for a payload. Deliveries are
 * already signed by the server; this exists for tests and local tooling.
 */
export function signWebhook(
  secret: string,
  body: WebhookBody,
  timestampSec: number = Math.floor(Date.now() / 1000),
): string {
  const t = String(timestampSec);
  return `t=${t},v1=${signatureHex(secret, t, body)}`;
}

/**
 * Verify a webhook delivery. Pass the secret returned when the webhook was
 * created, the `Matih-Signature` header, and the exact raw request body
 * (not re-serialised JSON). Returns false for a missing or malformed header,
 * a timestamp outside `toleranceSec`, or a signature mismatch. The signature
 * comparison is constant-time.
 */
export function verifyWebhook(
  secret: string,
  header: string | null | undefined,
  body: WebhookBody,
  toleranceSec: number = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (typeof header !== "string" || header === "" || header.length > 2048) return false;

  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") candidates.push(value);
  }
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp) || candidates.length === 0) return false;
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return false;

  const expected = Buffer.from(signatureHex(secret, timestamp, body), "hex");
  let matched = false;
  for (const candidate of candidates) {
    if (!/^[0-9a-fA-F]{64}$/.test(candidate)) continue;
    const given = Buffer.from(candidate, "hex");
    // timingSafeEqual throws on unequal lengths, so guard first.
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  return matched;
}
