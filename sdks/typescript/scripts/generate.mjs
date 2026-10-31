// Generates src/schema.d.ts from the OpenAPI spec kept at the repository root.
// The hand-written client does not import the generated file, so a missing
// spec is not an error: the script says so and exits cleanly.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const spec = fileURLToPath(new URL("../../../openapi/openapi.json", import.meta.url));
const out = fileURLToPath(new URL("../src/schema.d.ts", import.meta.url));

if (!existsSync(spec)) {
  console.log(`generate: ${spec} not found; skipping schema generation.`);
  process.exit(0);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["--no-install", "openapi-typescript", spec, "-o", out], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
