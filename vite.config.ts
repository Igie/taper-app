import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The path the page talks to instead of a cross-origin endpoint, in dev.
 *
 * Some paid endpoints — Orbitflare among them — answer a POST with the right
 * `access-control-allow-origin` but answer the CORS *preflight* with a JSON-RPC
 * error and no CORS headers at all. Every RPC call is `content-type:
 * application/json`, which always preflights, so the browser never gets as far
 * as the POST and the whole app reads as offline.
 *
 * The dev fix is to stop making it a cross-origin request: the page calls
 * `/rpc/devnet` on the Vite server and Vite forwards it, key and all, from
 * Node. The key stays on this machine instead of going into the bundle.
 *
 * A production build has no dev server behind it, so a *deployed* app still
 * needs an endpoint that answers preflight (or a proxy of its own) — this
 * covers `bun run dev`, nothing more.
 */
const DEVNET_PROXY = "/rpc/devnet";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const upstream = (env.VITE_DEVNET_RPC ?? "").trim();

  const proxy: Record<string, ProxyOptions> = {};
  let devnetRpc = upstream;
  if (mode !== "production" && /^https?:\/\//i.test(upstream)) {
    const url = new URL(upstream);
    proxy[DEVNET_PROXY] = {
      target: url.origin,
      changeOrigin: true,
      // The api_key lives in the query string, so the rewrite has to carry the
      // upstream's whole path *and* search, not just its path.
      rewrite: () => `${url.pathname}${url.search}`
    };
    devnetRpc = DEVNET_PROXY;
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
    define: {
      global: "globalThis",
      "process.env": {},
      // Overrides what `loadEnv` would otherwise have inlined, so the app sees
      // the proxy path in dev and the real endpoint in a build.
      "import.meta.env.VITE_DEVNET_RPC": JSON.stringify(devnetRpc)
    },
    server: {
      port: 5273,
      strictPort: false,
      proxy
    }
  };
});
