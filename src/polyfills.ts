/**
 * `Buffer` for the browser.
 *
 * web3.js and the SPL token libraries use it throughout, and Vite does not
 * polyfill Node globals. The cast goes through `unknown` because the shim is
 * deliberately not the full Node `BufferConstructor` — nothing here uses the
 * parts it leaves out.
 */
import { Buffer } from "buffer/";

(globalThis as unknown as { Buffer: unknown }).Buffer = Buffer;
