// Size budgets for what `npm publish` would upload. Run after `npm run build`; fails CI when the package grows
// past what a small client should weigh. Raise a budget on purpose, in the change that adds the weight.
//
// 0.1.0 measured: tarball 45.1 KB, unpacked 173 KB, 30 files (11 were source maps).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUDGET = {
  tarballBytes: 40 * 1024, // 0.1.0 was 45 KB with maps; about 30 KB without
  unpackedBytes: 150 * 1024,
  gzippedJsBytes: 22 * 1024, // all dist/*.js compressed together, what a bundler's output pays at most
  runtimeDependencies: ["openapi-fetch"],
};

const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }))[0];
const files = pack.files.map((f) => f.path);
const problems = [];

const stray = files.filter((p) => !(p === "package.json" || p === "README.md" || p === "LICENSE" || p === "NOTICE" || p.startsWith("dist/")));
if (stray.length) problems.push(`files outside dist/ and the metadata: ${stray.join(", ")}`);
const maps = files.filter((p) => p.endsWith(".map"));
if (maps.length) problems.push(`source maps shipped: ${maps.join(", ")}`);
const tests = files.filter((p) => /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\./.test(p));
if (tests.length) problems.push(`tests shipped: ${tests.join(", ")}`);
for (const required of ["dist/index.js", "dist/index.d.ts"]) {
  if (!files.includes(required)) problems.push(`missing ${required}: run npm run build first`);
}

const js = files.filter((p) => p.endsWith(".js"));
const gzippedJs = gzipSync(Buffer.concat(js.map((p) => readFileSync(p)))).length;

if (pack.size > BUDGET.tarballBytes) problems.push(`tarball ${pack.size} B > ${BUDGET.tarballBytes} B`);
if (pack.unpackedSize > BUDGET.unpackedBytes) problems.push(`unpacked ${pack.unpackedSize} B > ${BUDGET.unpackedBytes} B`);
if (gzippedJs > BUDGET.gzippedJsBytes) problems.push(`gzipped js ${gzippedJs} B > ${BUDGET.gzippedJsBytes} B`);

const deps = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {}).sort();
if (JSON.stringify(deps) !== JSON.stringify(BUDGET.runtimeDependencies)) {
  problems.push(`runtime dependencies are [${deps}], expected [${BUDGET.runtimeDependencies}]`);
}

console.log(`${pack.name}@${pack.version}: tarball ${pack.size} B, unpacked ${pack.unpackedSize} B, ${files.length} files, gzipped js ${gzippedJs} B`);
if (problems.length) {
  console.error(problems.map((p) => `size budget: ${p}`).join("\n"));
  process.exit(1);
}
