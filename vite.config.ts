import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The paths the page talks to instead of a cross-origin endpoint, in dev.
 *
 * Some paid endpoints — Orbitflare among them — answer a POST with the right
 * `access-control-allow-origin` but answer the CORS *preflight* with a JSON-RPC
 * error and no CORS headers at all. Every RPC call is `content-type:
 * application/json`, which always preflights, so the browser never gets as far
 * as the POST and the whole app reads as offline.
 *
 * The dev fix is to stop making it a cross-origin request: the page calls
 * `/rpc/<network>` on the Vite server and Vite forwards it, key and all, from
 * Node. The key stays on this machine instead of going into the bundle.
 *
 * Both public networks are proxied on the same rule, because a mainnet
 * endpoint is the one most likely to be a paid one with a key in it — and the
 * one where leaking that key into a bundle costs money.
 *
 * A production build has no dev server behind it, so a *deployed* app still
 * needs an endpoint that answers preflight (or a proxy of its own) — this
 * covers `bun run dev`, nothing more.
 */
const PROXIED = [
  { env: "VITE_DEVNET_RPC", path: "/rpc/devnet" },
  { env: "VITE_MAINNET_RPC", path: "/rpc/mainnet" }
] as const;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  const proxy: Record<string, ProxyOptions> = {};
  const define: Record<string, unknown> = {
    global: "globalThis",
    "process.env": {}
  };

  for (const { env: name, path } of PROXIED) {
    const upstream = (env[name] ?? "").trim();
    let value = upstream;
    if (mode !== "production" && /^https?:\/\//i.test(upstream)) {
      const url = new URL(upstream);
      proxy[path] = {
        target: url.origin,
        changeOrigin: true,
        // The api_key lives in the query string, so the rewrite has to carry
        // the upstream's whole path *and* search, not just its path.
        rewrite: () => `${url.pathname}${url.search}`
      };
      value = path;
    }
    // Overrides what `loadEnv` would otherwise have inlined, so the app sees
    // the proxy path in dev and the real endpoint in a build.
    define[`import.meta.env.${name}`] = JSON.stringify(value);
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        buffer: "buffer/"
      }
    },
    optimizeDeps: {
      include: ["buffer"]
    },
    // web3.js and the wallet adapters still reach for Node globals in a browser.
    define,
    server: {
      port: 5273,
      strictPort: false,
      proxy
    }
  };
});
