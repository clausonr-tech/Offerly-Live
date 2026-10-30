// pinnedFetch (src/lib/monitoring/safe-fetch.ts): the connection resolves its
// host through the internal-address check itself, so DNS rebinding - a name
// that answers "public" to a first lookup and 127.0.0.1 to the one that
// connects - has no second lookup to lie in. And it must still behave like
// fetch() for everything the crawler and the news pipeline rely on.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { BlockedAddressError, pinnedFetch } from "../../src/lib/monitoring/safe-fetch";

let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/gzip") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(zlib.gzipSync("<p>hello, compressed</p>"));
    } else if (req.url === "/echo") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.end(JSON.stringify({ method: req.method, type: req.headers["content-type"], body })));
    } else if (req.url === "/empty") {
      res.writeHead(204).end();
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: "/gzip" }).end();
    } else if (req.url === "/slow") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first part ");
      // never ends on its own
    } else res.end("plain");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const rebindsToLoopback = async () => [{ address: "127.0.0.1", family: 4 }];
// The tests' own server is on loopback, so the working-path tests allow it explicitly.
const reach = { resolve: rebindsToLoopback, allowed: () => true };

test("a name that resolves to loopback at connect time is never connected to", async () => {
  await assert.rejects(pinnedFetch(`http://rebind.example:${port}/`, {}, { resolve: rebindsToLoopback }), BlockedAddressError);
  await assert.rejects(
    pinnedFetch(`http://mixed.example:${port}/`, {}, { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] }),
    BlockedAddressError,
    "one internal address among public ones is enough to refuse",
  );
  await assert.rejects(pinnedFetch(`http://v6.example:${port}/`, {}, { resolve: async () => [{ address: "::ffff:7f00:1", family: 6 }] }), BlockedAddressError);
});

test("it still reads like fetch: decompressed bodies, headers, empty responses", async () => {
  const res = await pinnedFetch(`http://test.example:${port}/gzip`, {}, reach);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<p>hello, compressed</p>");
  assert.equal(res.headers.get("content-encoding"), null, "decoded, so the header goes");
  assert.equal(res.headers.get("content-type"), "text/html");
  const empty = await pinnedFetch(`http://test.example:${port}/empty`, {}, reach);
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
});

test("it sends the connectors' JSON bodies and does not follow redirects itself", async () => {
  const res = await pinnedFetch(`http://test.example:${port}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: 2 }) }, reach);
  assert.deepEqual(await res.json(), { method: "POST", type: "application/json", body: '{"page":2}' });
  const hop = await pinnedFetch(`http://test.example:${port}/redirect`, {}, reach);
  assert.equal(hop.status, 302);
  assert.equal(hop.headers.get("location"), "/gzip", "the caller follows it, re-checking the next hop");
});

test("an abort ends a response that never finishes, without crashing the process", async () => {
  const controller = new AbortController();
  const res = await pinnedFetch(`http://test.example:${port}/slow`, { signal: controller.signal }, reach);
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /first part/);
  controller.abort();
  await assert.rejects(reader.read());
});
