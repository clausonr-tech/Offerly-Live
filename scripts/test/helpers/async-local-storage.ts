// Next's request storage (cookies(), headers()) is built from
// globalThis.AsyncLocalStorage the moment its module first loads, and a plain
// Node test run never defines it. Import this FIRST in a test that calls code
// reading the request (getStudentTimeZone, say) through a static import chain,
// so the storage exists before anything builds on it.
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
