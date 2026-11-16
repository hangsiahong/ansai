#!/usr/bin/env bun
/**
 * Builds the web app into a folder, ready for the server to hand out.
 *
 *   bun scripts/build-web.ts <folder>
 *
 * A release runs this into dist/web/<commit>/ (see scripts/release.sh and src/server/webdist.ts)
 * so the service doesn't bundle the app inside its own process. It does what Bun's HTML import
 * does for the running server (minified, production, the tsconfig's JSX settings), with
 * hashed file names and an absolute /_app/ public path: the page is served at nested
 * addresses (/p/<id>, /s/<id>), where a relative ./file.js would not be found.
 *
 * The app is built next to <folder> and moved into place only once it is complete and checked,
 * so a half-written build is never served; if anything fails, <folder> is left as it was.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WEB_PREFIX } from "../src/server/webdist";

const target = process.argv[2];
if (!target || process.argv.length > 3) {
  console.error("usage: bun scripts/build-web.ts <folder>");
  process.exit(2);
}
const out = resolve(target);
const staging = `${out}.building-${process.pid}`;

function fail(msg: string): never {
  rmSync(staging, { recursive: true, force: true });
  console.error(`build-web: ${msg}`);
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
rmSync(staging, { recursive: true, force: true });

const started = performance.now();
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/web/index.html")],
  outdir: staging,
  target: "browser",
  minify: true,
  splitting: true,
  sourcemap: "none",
  publicPath: WEB_PREFIX,
  define: { "process.env.NODE_ENV": '"production"' },
}).catch((e: unknown) => {
  // A failed build throws; what went wrong is in the errors it carries (file, line, message).
  const errors: any[] = e instanceof AggregateError ? e.errors : [e];
  return fail(`the bundler failed:\n${errors.map((x) => `${x?.message ?? x}${x?.position ? ` (${x.position.file}:${x.position.line})` : ""}`).join("\n")}`);
});
if (!result.success) fail(`the bundler failed:\n${result.logs.map(String).join("\n")}`);

// Check the result is what the server expects: a page, and every /_app/<file> that the page,
// the scripts and the styles mention is a file here (fonts, icons and chunks included), with
// nothing in a sub-folder (the server only hands out files from the top).
const names = readdirSync(staging, { withFileTypes: true });
if (names.some((e) => !e.isFile())) fail("the build has sub-folders; the server only serves the top level");
if (!names.some((e) => e.name === "index.html")) fail("the build has no index.html");
const have = new Set(names.map((e) => e.name));
const page = readFileSync(join(staging, "index.html"), "utf8");
if (!/<script[^>]+src="\/_app\/[^"]+\.js"/.test(page)) fail("index.html doesn't load its script from /_app/");
let mentioned = 0;
for (const e of names) {
  if (!/\.(html|js|css)$/.test(e.name)) continue;
  for (const m of readFileSync(join(staging, e.name), "utf8").matchAll(/\/_app\/([A-Za-z0-9._-]+)/g)) {
    mentioned++;
    if (!have.has(m[1]!)) fail(`${e.name} refers to ${WEB_PREFIX}${m[1]}, which wasn't built`);
  }
}

rmSync(out, { recursive: true, force: true });
renameSync(staging, out);
console.log(`Built the web app: ${have.size} files, ${mentioned} references checked, ${Math.round(performance.now() - started)} ms -> ${out}`);
