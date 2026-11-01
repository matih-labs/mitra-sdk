// Size budgets for what `npm publish` would upload. Run after `npm run build`; fails CI when the element
// grows past what a drop-in `<script type="module">` should cost a page. Raise a budget on purpose.
//
// 0.1.0 measured: tarball 16.4 KB (with a 12 KB source map), index.js 16.5 KB, 6.0 KB gzipped.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUDGET = {
  tarballBytes: 20 * 1024, // 0.1.1 with the Ask box (kind="ask", mountAsk) and signed-token checks: 16.9 KB
  indexJsBytes: 24 * 1024, // 0.1.1: 21.4 KB
  indexJsGzippedBytes: 8 * 1024, // what a page downloads
};

const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }))[0];
const files = pack.files.map((f) => f.path);
const problems = [];

const stray = files.filter((p) => !(p === "package.json" || p === "README.md" || p === "LICENSE" || p === "NOTICE" || p.startsWith("dist/")));
if (stray.length) problems.push(`files outside dist/ and the metadata: ${stray.join(", ")}`);
const maps = files.filter((p) => p.endsWith(".map"));
if (maps.length) problems.push(`source maps shipped: ${maps.join(", ")}`);
for (const required of ["dist/index.js", "dist/index.d.ts"]) {
  if (!files.includes(required)) problems.push(`missing ${required}: run npm run build first`);
}
if (files.filter((p) => p.endsWith(".js")).length !== 1) problems.push("the element must be one self-contained file");

const source = readFileSync("dist/index.js");
const gzipped = gzipSync(source).length;
if (/^\s*(import|export\s.*from)\s/m.test(source.toString("utf8"))) problems.push("dist/index.js imports another module: it must stand alone");
if (pack.size > BUDGET.tarballBytes) problems.push(`tarball ${pack.size} B > ${BUDGET.tarballBytes} B`);
if (source.length > BUDGET.indexJsBytes) problems.push(`index.js ${source.length} B > ${BUDGET.indexJsBytes} B`);
if (gzipped > BUDGET.indexJsGzippedBytes) problems.push(`index.js gzipped ${gzipped} B > ${BUDGET.indexJsGzippedBytes} B`);
if (Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {}).length) problems.push("the element has runtime dependencies");

console.log(`${pack.name}@${pack.version}: tarball ${pack.size} B, index.js ${source.length} B (${gzipped} B gzipped), ${files.length} files`);
if (problems.length) {
  console.error(problems.map((p) => `size budget: ${p}`).join("\n"));
  process.exit(1);
}
