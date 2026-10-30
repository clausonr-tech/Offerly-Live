import type { PgDatabase } from "drizzle-orm/pg-core/db";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import type * as schema from "./schema";

/**
 * A database handle, whichever driver is underneath.
 *
 * `getDb()` and `openDb()` both return PGlite's drizzle instance or
 * postgres-js's depending on the environment. Writing a parameter as
 * `Awaited<ReturnType<typeof getDb>>` therefore types it as a UNION of two
 * drivers, and TypeScript resolves a method call on a union to the
 * INTERSECTION of the overloads - which silently drops `.returning({ id })`
 * and `.execute<T>()`. A function written against the union compiles until a
 * caller needs one of those.
 *
 * Both drivers extend `PgDatabase`, so this names the supertype they share.
 * It is not an assertion that the two are interchangeable: `db.execute()`
 * genuinely returns `{ rows }` on PGlite and a bare array on postgres-js, and
 * a caller that uses it still has to handle both (see scripts/schema-drift.ts).
 * What it does mean is that a helper taking `Db` can be called with either.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
