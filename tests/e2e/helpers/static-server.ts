// Minimal static file server for the built extension's review page.
// Used as Playwright's `webServer` so tests can `file://`-equivalent
// load the bundle over http (modules + relative imports work cleanly).
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../.output/chrome-mv3");
const port = Number(process.env.E2E_PORT ?? 4170);

if (!existsSync(root)) {
  console.error(`E2E server: build output not found at ${root}. Run \`bun run build\` first.`);
  process.exit(1);
}

const mime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
};

Bun.serve({
  port,
  development: false,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/review.html" : url.pathname;
    const file = Bun.file(resolve(root, `.${path}`));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const ext = path.split(".").pop() ?? "";
    return new Response(file, {
      headers: { "content-type": mime[ext] ?? "application/octet-stream" },
    });
  },
});
console.log(`E2E server listening on http://localhost:${port} (root: ${root})`);
