// `bun run preview`: the review page on a plain Vite dev server (no extension
// build, HMR on save), fed by the fixture PR in fake-github.ts.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  publicDir: here("../../public"),
  envPrefix: ["BARK_"],
  // Show the reviewer/author switch so both roles can be checked.
  define: { "import.meta.env.BARK_DEV_ROLE_SWITCH": JSON.stringify("1") },
  resolve: { alias: { "wxt/browser": here("./browser-shim.ts") } },
  plugins: [react()],
  server: { host: "localhost", port: 5174, strictPort: true },
});
