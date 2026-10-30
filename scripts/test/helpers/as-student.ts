/**
 * Driving a "use server" action as a signed-in student, in a plain Node test.
 *
 * Two things stand between a test and a server action:
 *
 *   - the action module imports next/navigation for redirect(), whose client
 *     half cannot load outside Next. Stubbed here on import, the same way
 *     practice-workflows.test.ts does it: redirect() and notFound() throw, as
 *     they do in a real request, and nothing else is used server-side.
 *   - cookies() reads Next's request storage. asStudent() inserts a real
 *     session row and runs the action inside that storage with a jar holding
 *     its token, so getCurrentUser() resolves to the user.
 *
 * IMPORT THIS BEFORE dynamically importing the action under test, so the stub
 * is in the require cache first.
 */

import Module from "node:module";
import crypto from "node:crypto";

import "./async-local-storage";
import type { TestDb } from "./test-db";

// next/navigation's client half cannot load under the react-server condition.
{
  const navPath = require.resolve("next/navigation");
  const stub = new Module(navPath);
  stub.filename = navPath;
  stub.loaded = true;
  const thrower = (kind: string) => (to?: string) => {
    throw new Error(`NEXT_${kind}${to ? `:${to}` : ""}`);
  };
  stub.exports = new Proxy(
    {
      redirect: thrower("REDIRECT"),
      permanentRedirect: thrower("REDIRECT"),
      notFound: thrower("NOT_FOUND"),
    },
    {
      get: (t, k) =>
        k === "__esModule" ? true : ((t as Record<string | symbol, unknown>)[k] ?? (() => null)),
    },
  );
  require.cache[navPath] = stub;
}

// revalidatePath/revalidateTag need Next's static-generation store, which only
// a real request has. A server action calling them is reporting "this page's
// cache is stale", which is meaningless in a test, so they are no-ops here -
// without this every action that revalidates throws "static generation store
// missing" instead of returning its result.
{
  const cachePath = require.resolve("next/cache");
  const stub = new Module(cachePath);
  stub.filename = cachePath;
  stub.loaded = true;
  stub.exports = new Proxy(
    {
      revalidatePath: () => {},
      revalidateTag: () => {},
      unstable_cache: <T>(fn: T) => fn,
    },
    {
      get: (t, k) =>
        k === "__esModule" ? true : ((t as Record<string | symbol, unknown>)[k] ?? (() => {})),
    },
  );
  require.cache[cachePath] = stub;
}

const DAY = 86_400_000;

/** Run `fn` as the given user: a real session row and its cookie. */
export async function asStudent<T>(
  db: TestDb,
  userId: string,
  fn: () => Promise<T>,
  options: { route?: string; timeZone?: string } = {},
): Promise<T> {
  type Storage = { run: <R>(store: never, fn: () => R) => R };
  const workStorage = (await import("next/dist/server/app-render/work-async-storage.external"))
    .workAsyncStorage as unknown as Storage;
  const workUnitStorage = (
    await import("next/dist/server/app-render/work-unit-async-storage.external")
  ).workUnitAsyncStorage as unknown as Storage;
  const token = crypto.randomBytes(24).toString("hex");
  const { sessions } = await import("@/db/schema");
  await db.insert(sessions).values({
    userId,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + DAY),
  });
  const jar = {
    get: (name: string) =>
      name === "session_token"
        ? { name, value: token }
        : name === "tz"
          ? { name, value: options.timeZone ?? "America/New_York" }
          : undefined,
  };
  return workStorage.run({ route: options.route ?? "/" } as never, () =>
    workUnitStorage.run({ type: "private-cache", phase: "render", cookies: jar } as never, fn),
  );
}
