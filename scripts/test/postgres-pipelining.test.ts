// No query is ever written onto a connection that is still busy.
//
// On 24 September 2026 the dev server wedged for ten minutes at a time: its
// connections sat `active` / ClientRead in pg_stat_activity, Postgres waiting
// on a client that was waiting on Postgres. postgres-js pipelines by default -
// with every connection busy it writes the next query behind a running one -
// and Supavisor's transaction mode strands a pipelined query for good. No
// timeout on either side ends it. src/db/connection.ts sets max_pipeline: 0,
// which needs patches/postgres+3.4.9.patch for transactions to keep working.
//
// Supavisor cannot run here, so these tests watch the wire instead: a proxy
// between the app's client and a real Postgres reads the protocol and counts
// every query that starts before the previous one on that connection has been
// answered with ReadyForQuery. That count is what reaches the pooler, and it
// has to be zero.

import assert from "node:assert/strict";
import net from "node:net";
import { after, before, test } from "node:test";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

import { createPostgresClient } from "../../src/db/connection";
import { postgresAvailability, startRealPostgres, type RealPostgres } from "./helpers/real-postgres";

const availability = postgresAvailability();
// The one honest skip: a machine without Postgres binaries cannot run this.
const skipIfNoPostgres = availability.ok ? undefined : { skip: availability.why };
if (!availability.ok) console.warn(`SKIPPING postgres-pipelining: ${availability.why}`);

/** A loopback proxy that counts pipelined queries on the wire. */
async function wireCounter(targetPort: number) {
  const counts = { queries: 0, pipelined: 0 };
  const sockets = new Set<net.Socket>();

  // Splits a byte stream into protocol messages. The client's first message
  // (the startup packet) has no type byte.
  const reader = (untypedFirst: boolean, onType: (t: string) => void) => {
    let buf = Buffer.alloc(0);
    let first = untypedFirst;
    return (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (first) {
          if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
          buf = buf.subarray(buf.readInt32BE(0));
          first = false;
          continue;
        }
        if (buf.length < 5 || buf.length < buf.readInt32BE(1) + 1) return;
        onType(String.fromCharCode(buf[0]));
        buf = buf.subarray(buf.readInt32BE(1) + 1);
      }
    };
  };

  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    sockets.add(client).add(upstream);
    // Syncs and simple queries not yet answered, and whether an extended
    // query is open (Parse sent, Sync not yet).
    let unanswered = 0;
    let open = false;
    const fromClient = reader(true, (t) => {
      if (t === "P" || t === "Q") {
        counts.queries += 1;
        if (unanswered > 0 || open) counts.pipelined += 1;
      }
      if (t === "P") open = true;
      if (t === "S") {
        open = false;
        unanswered += 1;
      }
      if (t === "Q") unanswered += 1;
    });
    const fromServer = reader(false, (t) => {
      if (t === "Z") unanswered = Math.max(0, unanswered - 1);
    });
    client.on("data", (c) => (fromClient(c), upstream.write(c)));
    upstream.on("data", (c) => (fromServer(c), client.write(c)));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    counts,
    url: (target: string) => target.replace(/:(\d+)\//, `:${port}/`),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

let pg: RealPostgres;
let wire: Awaited<ReturnType<typeof wireCounter>>;

before(async () => {
  if (!availability.ok) return;
  pg = await startRealPostgres();
  wire = await wireCounter(Number(new URL(pg.url).port));
});

after(async () => {
  await wire?.close();
  await pg?.stop();
});

/** The app's own client, through the counting proxy, with a pool of two. */
function appClient() {
  const client = createPostgresClient(wire.url(pg.url), {
    max: 2,
    pooling: "as-configured",
    allowLocalTestPlaintext: true,
    onnotice: () => {},
  });
  return { sql: client.sql, db: drizzle(client.sql) };
}

test("a saturated pool queues queries instead of pipelining them", skipIfNoPostgres, async () => {
  const { sql: client, db } = appClient();
  try {
    // Both connections open first, so their one-off type lookups are not
    // counted among the queries below.
    await Promise.all([db.execute(sql`select pg_sleep(0.05)`), db.execute(sql`select pg_sleep(0.05)`)]);
    const before = { ...wire.counts };

    // Parameterless queries are the ones postgres-js will pipeline behind -
    // drizzle sends them as simple queries - so two slow ones hold both
    // connections while a dozen more arrive, with and without parameters.
    const results = await Promise.all([
      db.execute(sql`select pg_sleep(0.2), 'slow-a' as tag`),
      db.execute(sql`select pg_sleep(0.2), 'slow-b' as tag`),
      ...Array.from({ length: 12 }, (_, i) =>
        i % 2 ? db.execute(sql`select ${i}::int as n`) : db.execute(sql.raw(`select ${i} as n`)),
      ),
    ]);

    assert.deepEqual(
      results.slice(2).map((r) => Number(r[0].n)),
      Array.from({ length: 12 }, (_, i) => i),
      "every query got its own answer",
    );
    assert.equal(wire.counts.queries - before.queries, 14);
    assert.equal(
      wire.counts.pipelined - before.pipelined,
      0,
      "a query was written onto a busy connection - behind Supavisor's transaction mode that stalls it forever",
    );
  } finally {
    await client.end({ timeout: 2 });
  }
});

test("transactions still work with pipelining off, under a saturated pool", skipIfNoPostgres, async () => {
  const { sql: client, db } = appClient();
  try {
    await db.execute(sql`create table if not exists pipeline_probe (id int)`);
    await db.execute(sql`truncate pipeline_probe`);
    const before = { ...wire.counts };

    // Without the patch this throws UNSAFE_TRANSACTION before it starts.
    let seenInside = -1;
    const inside = db.transaction(async (tx) => {
      await tx.execute(sql`insert into pipeline_probe values (${1})`);
      // Long enough for every outside query below to arrive while it is open.
      await tx.execute(sql`select pg_sleep(0.3)`);
      const [{ n }] = await tx.execute(sql`select count(*)::int as n from pipeline_probe`);
      seenInside = Number(n);
      tx.rollback();
    });

    // Meanwhile the rest of the pool is saturated. None of these may run
    // inside that transaction - any that did would see its uncommitted row.
    const outside = Promise.all(
      Array.from({ length: 10 }, () => db.execute(sql`select count(*)::int as n from pipeline_probe`)),
    );

    await assert.rejects(inside, /Rollback/, "the transaction ran and rolled back");
    assert.equal(seenInside, 1, "the transaction saw its own row");
    const seen = (await outside).map((r) => Number(r[0].n));
    assert.deepEqual(seen, Array(10).fill(0), "no outside query ran inside the transaction");
    const [{ n }] = await db.execute(sql`select count(*)::int as n from pipeline_probe`);
    assert.equal(Number(n), 0, "the rollback took the row with it");
    assert.equal(wire.counts.pipelined - before.pipelined, 0, "nothing was pipelined");
  } finally {
    await client.end({ timeout: 2 });
  }
});
