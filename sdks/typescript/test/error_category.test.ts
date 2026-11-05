/**
 * `err.category` is the `category` string the server sent, else undefined. The table is shared with the Python SDK
 * (sdks/error_category_cases.json, sdks/python/tests/test_error_category.py), so the two cannot drift.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConnectionError } from "../src/index.js";
import { errorFromResponse } from "../src/errors.js";
import { makeClient, networkError, sequence } from "./helpers.js";

interface Case {
  name: string;
  status: number;
  body: string;
  category: string | null;
}

const cases: Case[] = JSON.parse(readFileSync(new URL("../../error_category_cases.json", import.meta.url), "utf8")).cases;

describe("error category", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const err = errorFromResponse(c.status, new Headers(), c.body);
    expect(err.category).toBe(c.category ?? undefined);
  });

  it("a request with no response names its own category, as the Python SDK does", async () => {
    const err = await makeClient(sequence(networkError()).fetch, { maxRetries: 0 }).sources.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect([(err as ConnectionError).status, (err as ConnectionError).category]).toEqual([0, "network"]);
  });
});
