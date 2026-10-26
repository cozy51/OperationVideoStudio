import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Only this site may be contacted: videos stay in the browser. Added to
// production builds only, because the dev server injects inline scripts.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const contentSecurityPolicy = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: csp },
      injectTo: "head-prepend",
    },
  ],
});
export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  server: { port: 1420, strictPort: true },
  // ffmpeg.wasm starts its own module worker; pre-bundling breaks the worker URL.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
  worker: { format: "es" },
  clearScreen: false,
});
