// /networking feed benchmark, against synthetic data in a throwaway in-memory
// PGlite database. Never a real database: DATABASE_URL is removed, and every
// row here is generated - no real user, no network, no paid API.
//
//   node --import tsx --conditions=react-server scripts/bench/feed-bench.ts [sizes] [--out file.json]
//   e.g. scripts/bench/feed-bench.ts 1000,10000,100000 --out /tmp/feed-before.json
//
// For each feed size it seeds users, events, seen rows (the viewer's and
// everyone else's), reactions, comments, peer links, top firms and
// discussions, then measures - median of several runs after a warm-up - the
// first feed page, a later page in the unseen group, a page deep in the seen
// group, the queries each costs, and the other reads /networking makes in
// parallel. It also prints EXPLAIN ANALYZE for the feed's own query.
//
// PGlite is Postgres compiled to WebAssembly, single-threaded and in-process:
// the planner and plans are Postgres's own, but absolute times are not those of
// the hosted database (no network, slower executor). Compare runs with each
// other, not with production.

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { createTestDb, type TestDatabase } from "../test/helpers/test-db";
import { getFeedPage } from "@/lib/activity";
import { listDiscussions } from "@/lib/discussions";
import {
  getDirectoryMembers,
  getPublicProfile,
  getSimilarityProfile,
} from "@/lib/people";
import { getPeerStates } from "@/lib/peers";

delete process.env.DATABASE_URL;

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outFile = outAt >= 0 ? args[outAt + 1] : null;
const sizes = (args.find((a) => /^\d[\d,]*$/.test(a)) ?? "1000,10000,100000")
  .split(",")
  .map(Number);
const RUNS = 7;

type Captured = { sql: string; params: unknown[] };

async function seed(h: TestDatabase, events: number) {
  const nUsers = Math.max(200, Math.round(events / 20));
  const q = (s: string) => h.client.exec(s);
  // Deterministic pseudo-randomness, so before and after runs see the same data.
  await q(`select setseed(0.42)`);
  await q(`
    insert into users (email, password_hash, name, school, major, grad_year)
    select 'bench-' || i || '@example.edu', 'x', 'Student ' || i, 'School ' || (i % 40), 'Economics', 2026 + (i % 4)
    from generate_series(1, ${nUsers}) i`);
  await q(`
    insert into firms (slug, name, headquarters, key_offices, website, description)
    select 'bench-firm-' || i, 'Bench Firm ' || i, 'New York, NY', 'New York, NY', 'firm' || i || '.example.com', 'x'
    from generate_series(1, 200) i`);
  await q(
    `create temp table u as select id, row_number() over (order by email) as n from users`,
  );
  await q(
    `create temp table f as select id, row_number() over (order by slug) as n from firms`,
  );
  // A year of activity, newest at "now - 1 minute".
  await q(`
    insert into activity_events (user_id, kind, dedupe_key, body, created_at)
    select u.id,
           (array['post','post','post','joined','streak','offer'])[1 + (i % 6)]::activity_kind,
           'bench-' || i,
           case when i % 6 < 3 then 'Post number ' || i end,
           now() - interval '1 minute' - (interval '365 days' * random())
    from generate_series(1, ${events}) i
    join u on u.n = 1 + (i % ${nUsers})`);
  await q(
    `create temp table e as select id, created_at, row_number() over (order by created_at desc, id desc) as n from activity_events`,
  );
  const viewer = (
    await h.client.query<{ id: string }>(`select id from u where n = 1`)
  ).rows[0].id;
  // The viewer has seen 30% of the feed, mostly recent; everyone else has seen
  // a scatter of it, so the table is the size a busy one would be.
  await q(`
    insert into activity_seen (user_id, event_id, seen_at)
    select '${viewer}', id, now() - interval '2 minutes' from e where random() < case when n <= ${Math.round(events * 0.2)} then 0.9 else 0.15 end`);
  await q(`
    insert into activity_seen (user_id, event_id, seen_at)
    select u.id, e.id, now() - interval '1 hour'
    from e join u on u.n = 2 + ((e.n * 7) % ${nUsers - 1})
    where random() < 0.6
    on conflict do nothing`);
  // A heavy reader: has had every row in the newer half of the feed on screen,
  // so the unseen walk must step past all of them before finding a new one.
  const heavyReader = (await h.client.query<{ id: string }>(`select id from u where n = 2`)).rows[0].id;
  await q(`
    insert into activity_seen (user_id, event_id, seen_at)
    select '${heavyReader}', id, now() - interval '2 minutes' from e where n <= ${Math.round(events / 2)}
    on conflict (user_id, event_id) do update set seen_at = excluded.seen_at`);
  await q(`
    insert into activity_reactions (event_id, user_id, emoji)
    select e.id, u.id, (array['🔥','👏','🎉','❤️'])[1 + (e.n % 4)::int]
    from e join u on u.n = 1 + ((e.n * 13) % ${nUsers})
    where random() < 0.5
    on conflict do nothing`);
  await q(`
    insert into activity_comments (event_id, user_id, body)
    select e.id, u.id, 'Nice one'
    from e join u on u.n = 1 + ((e.n * 17) % ${nUsers})
    where random() < 0.2`);
  await q(`
    insert into peer_links (user_id, peer_id)
    select a.id, b.id from u a cross join generate_series(1, 3) k
    join u b on b.n = 1 + ((a.n * 3 + k) % ${nUsers}) where a.id <> b.id
    on conflict do nothing`);
  await q(`
    insert into user_top_firms (user_id, firm_id)
    select u.id, f.id from u cross join generate_series(1, 5) k
    join f on f.n = 1 + ((u.n * 5 + k) % 200)
    on conflict do nothing`);
  await q(`
    insert into discussions (title, body, topic, author_id, last_activity_at)
    select 'Thread ' || i, 'Body', 'general', u.id, now() - (interval '30 days' * random())
    from generate_series(1, 200) i join u on u.n = 1 + (i % ${nUsers})`);
  await q(`analyze`);
  return { viewer, heavyReader, nUsers };
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function measure<T>(
  h: TestDatabase,
  counter: { n: number },
  fn: () => Promise<T>,
) {
  await fn(); // warm-up
  const times: number[] = [];
  let queries = 0;
  let result!: T;
  for (let i = 0; i < RUNS; i++) {
    const before = counter.n;
    const t = performance.now();
    result = await fn();
    times.push(performance.now() - t);
    queries = counter.n - before;
  }
  return { ms: Number(median(times).toFixed(2)), queries, result };
}

function cursorFor(g: 0 | 1, t: string, id: string) {
  return Buffer.from(JSON.stringify({ g, t, id })).toString("base64url");
}

async function benchSize(events: number) {
  const h = await createTestDb();
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
  const counter = { n: 0 };
  let capture: Captured[] | null = null;
  const query = h.client.query.bind(h.client);
  h.client.query = ((sql: string, params?: unknown[], opts?: unknown) => {
    counter.n++;
    capture?.push({ sql, params: params ?? [] });
    return query(sql, params as never, opts as never);
  }) as typeof h.client.query;

  const t0 = performance.now();
  const { viewer, heavyReader, nUsers } = await seed(h, events);
  const seedMs = performance.now() - t0;
  const snapshot = new Date();
  const counts = Object.fromEntries(
    await Promise.all(
      [
        "activity_events",
        "activity_seen",
        "activity_reactions",
        "activity_comments",
        "users",
      ].map(async (t) => [
        t,
        (await query<{ n: number }>(`select count(*)::int as n from ${t}`))
          .rows[0].n,
      ]),
    ),
  );

  const first = await measure(h, counter, () =>
    getFeedPage(viewer, { snapshot }),
  );
  let cursor = first.result.nextCursor;
  for (let i = 0; i < 2 && cursor; i++)
    cursor = (await getFeedPage(viewer, { cursor, snapshot })).nextCursor;
  const page3 = await measure(h, counter, () =>
    getFeedPage(viewer, { cursor, snapshot }),
  );

  const heavyFirst = await measure(h, counter, () => getFeedPage(heavyReader, { snapshot }));

  // A page deep in the seen group: start after the median seen row.
  const mid = (
    await query<{ t: string; id: string }>(
      `select e.created_at::text as t, e.id from activity_events e join activity_seen s on s.event_id = e.id and s.user_id = $1
       order by e.created_at desc, e.id desc offset (select count(*) / 2 from activity_seen where user_id = $1) limit 1`,
      [viewer],
    )
  ).rows[0];
  const deepSeen = await measure(h, counter, () =>
    getFeedPage(viewer, { cursor: cursorFor(1, mid.t, mid.id), snapshot }),
  );

  // The other reads /networking starts alongside the feed.
  const side = {
    listDiscussions: await measure(h, counter, () =>
      listDiscussions(viewer, { limit: 5 }),
    ),
    getDirectoryMembers: await measure(h, counter, () =>
      getDirectoryMembers(viewer, 12),
    ),
    getSimilarityProfile: await measure(h, counter, () =>
      getSimilarityProfile(viewer),
    ),
    getPeerStates: await measure(h, counter, () => getPeerStates(viewer)),
    getPublicProfile: await measure(h, counter, () =>
      getPublicProfile(viewer, viewer),
    ),
  };
  const wholePage = await measure(h, counter, () =>
    Promise.all([
      getPublicProfile(viewer, viewer),
      listDiscussions(viewer, { limit: 5 }),
      getFeedPage(viewer, { snapshot }),
      getDirectoryMembers(viewer, 12),
      getSimilarityProfile(viewer),
      getPeerStates(viewer),
    ]),
  );

  // EXPLAIN ANALYZE of each statement the first and deep pages send that
  // touches activity_events directly.
  const plans: Record<string, string[]> = {};
  for (const [label, fn] of [
    ["first", () => getFeedPage(viewer, { snapshot })],
    [
      "deepSeen",
      () =>
        getFeedPage(viewer, { cursor: cursorFor(1, mid.t, mid.id), snapshot }),
    ],
  ] as const) {
    capture = [];
    await fn();
    const feedQueries = capture.filter((c) =>
      /from "activity_events"/.test(c.sql),
    );
    capture = null;
    plans[label] = [];
    for (const c of feedQueries) {
      const plan = await query<{ "QUERY PLAN": string }>(
        `explain (analyze, buffers) ${c.sql}`,
        c.params as never,
      );
      plans[label].push(plan.rows.map((r) => r["QUERY PLAN"]).join("\n"));
    }
  }

  await h.close();
  const pick = (m: { ms: number; queries: number }) => ({
    ms: m.ms,
    queries: m.queries,
  });
  return {
    events,
    users: nUsers,
    rows: counts,
    seedSeconds: Number((seedMs / 1000).toFixed(1)),
    feed: {
      firstPage: { ...pick(first), items: first.result.items.length },
      page3: { ...pick(page3), items: page3.result.items.length },
      deepSeenPage: { ...pick(deepSeen), items: deepSeen.result.items.length },
      heavyReaderFirstPage: { ...pick(heavyFirst), items: heavyFirst.result.items.length },
    },
    side: Object.fromEntries(
      Object.entries(side).map(([k, v]) => [k, pick(v)]),
    ),
    wholePage: pick(wholePage),
    plans,
  };
}

async function main() {
  const results = [];
  for (const n of sizes) {
    const r = await benchSize(n);
    results.push(r);
    console.log(
      `\n=== ${n.toLocaleString()} events, ${r.users.toLocaleString()} users (seeded in ${r.seedSeconds}s) ===`,
    );
    console.log(`rows: ${JSON.stringify(r.rows)}`);
    for (const [k, v] of Object.entries(r.feed))
      console.log(
        `feed ${k.padEnd(13)} ${String(v.ms).padStart(9)} ms  ${v.queries} queries  ${v.items} items`,
      );
    for (const [k, v] of Object.entries(r.side))
      console.log(
        `side ${k.padEnd(20)} ${String(v.ms).padStart(9)} ms  ${v.queries} queries`,
      );
    console.log(
      `whole /networking read set   ${String(r.wholePage.ms).padStart(9)} ms  ${r.wholePage.queries} queries`,
    );
    for (const [label, plans] of Object.entries(r.plans)) {
      plans.forEach((p, i) =>
        console.log(`\n--- plan: ${label} page, statement ${i + 1} ---\n${p}`),
      );
    }
  }
  if (outFile) {
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(`\nwrote ${outFile}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
