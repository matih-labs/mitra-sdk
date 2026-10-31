import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Mitra, signWebhook, verifyWebhook } from "../src/index.js";

const SECRET = "whsec_test_secret";
const BODY = '{"event":"job.completed","id":"evt_1"}';
const NOW = 1_800_000_000;

function header(secret: string, body: string, t: number): string {
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

describe("verifyWebhook", () => {
  it("accepts a valid signature", () => {
    expect(verifyWebhook(SECRET, header(SECRET, BODY, NOW), BODY, 300, NOW)).toBe(true);
  });

  it("accepts a Uint8Array body", () => {
    const bytes = new TextEncoder().encode(BODY);
    expect(verifyWebhook(SECRET, header(SECRET, BODY, NOW), bytes, 300, NOW)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhook(SECRET, header(SECRET, BODY, NOW), `${BODY} `, 300, NOW)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyWebhook("whsec_other", header(SECRET, BODY, NOW), BODY, 300, NOW)).toBe(false);
  });

  it("rejects a stale timestamp", () => {
    expect(verifyWebhook(SECRET, header(SECRET, BODY, NOW - 301), BODY, 300, NOW)).toBe(false);
  });

  it("rejects a timestamp too far in the future", () => {
    expect(verifyWebhook(SECRET, header(SECRET, BODY, NOW + 301), BODY, 300, NOW)).toBe(false);
  });

  it("accepts a timestamp at the edge of the tolerance", () => {
    expect(verifyWebhook(SECRET, header(SECRET, BODY, NOW - 300), BODY, 300, NOW)).toBe(true);
  });

  it("honours a custom tolerance", () => {
    const h = header(SECRET, BODY, NOW - 1000);
    expect(verifyWebhook(SECRET, h, BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, h, BODY, 2000, NOW)).toBe(true);
  });

  it("rejects missing and malformed headers", () => {
    expect(verifyWebhook(SECRET, undefined, BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, null, BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, "", BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, "garbage", BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, `t=${NOW}`, BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, "v1=abcd", BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, `t=abc,v1=${"0".repeat(64)}`, BODY, 300, NOW)).toBe(false);
  });

  it("rejects signatures of the wrong length or alphabet without throwing", () => {
    expect(verifyWebhook(SECRET, `t=${NOW},v1=abcd`, BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, `t=${NOW},v1=${"a".repeat(65)}`, BODY, 300, NOW)).toBe(false);
    expect(verifyWebhook(SECRET, `t=${NOW},v1=${"z".repeat(64)}`, BODY, 300, NOW)).toBe(false);
  });

  it("accepts when any of several v1 signatures matches", () => {
    const good = header(SECRET, BODY, NOW);
    const sig = good.split("v1=")[1] as string;
    const multi = `t=${NOW},v1=${"0".repeat(64)},v1=${sig}`;
    expect(verifyWebhook(SECRET, multi, BODY, 300, NOW)).toBe(true);
  });

  it("matches uppercase hex", () => {
    const good = header(SECRET, BODY, NOW);
    const [t, sig] = good.split(",v1=") as [string, string];
    expect(verifyWebhook(SECRET, `${t},v1=${sig.toUpperCase()}`, BODY, 300, NOW)).toBe(true);
  });

  it("uses the current time by default", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyWebhook(SECRET, header(SECRET, BODY, now), BODY)).toBe(true);
    expect(verifyWebhook(SECRET, header(SECRET, BODY, now - 3600), BODY)).toBe(false);
  });

  it("signWebhook round-trips", () => {
    expect(verifyWebhook(SECRET, signWebhook(SECRET, BODY, NOW), BODY, 300, NOW)).toBe(true);
    expect(signWebhook(SECRET, BODY, NOW)).toBe(header(SECRET, BODY, NOW));
  });

  it("is available as a client method", () => {
    const client = new Mitra({ apiKey: "mtk_test" });
    const now = Math.floor(Date.now() / 1000);
    expect(client.verifyWebhook(SECRET, signWebhook(SECRET, BODY, now), BODY)).toBe(true);
    expect(client.verifyWebhook(SECRET, signWebhook("whsec_other", BODY, now), BODY)).toBe(false);
  });
});
