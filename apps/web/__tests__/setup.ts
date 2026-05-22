/**
 * Vitest setup — JSDOM tweaks the AP2 component tests rely on.
 *
 * - SubtleCrypto: vitest/jsdom may lack `crypto.subtle.digest` in older
 *   environments. We polyfill from `node:crypto.webcrypto`.
 * - `Intl.NumberFormat`: jsdom uses the host's ICU data; nothing to polyfill.
 * - `navigator.credentials`: the WebAuthn tests use `testHook` to bypass.
 *   No global polyfill needed.
 * - RTL cleanup: with `globals: false`, React Testing Library cannot register
 *   its automatic `afterEach(cleanup)`, so mounted trees accumulate in JSDOM
 *   across tests and `getByRole` finds duplicates. Register cleanup explicitly.
 */
import { webcrypto } from "node:crypto";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  // Restore any per-test global stubs (e.g. the WebAuthn-capable env the
  // mandate-detail ceremony test installs via vi.stubGlobal).
  vi.unstubAllGlobals();
});

if (
  typeof globalThis.crypto === "undefined" ||
  typeof globalThis.crypto.subtle === "undefined"
) {
  // The cast is necessary because Node's webcrypto type doesn't fully match
  // the DOM Crypto interface; for our test purposes (subtle.digest, getRandomValues)
  // the two are interchangeable.
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
}
