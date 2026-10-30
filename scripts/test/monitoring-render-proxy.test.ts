// The render proxy (src/lib/monitoring/render-proxy.ts), which is where the
// address check now sits for the rendered crawl.
//
// Two findings meet here. First, DNS rebinding: generic.ts checked a name
// with Node's resolver and then let Chromium resolve it again when it
// connected, so the address checked was not the address dialled. Second,
// everything that is not the instrumented tab's own HTTP requests - a
// window.open popup is a separate Page with no interception, and a WebSocket
// handshake is not reported through the Fetch domain at all. A proxy is
// per-profile rather than per-page, and a proxied Chromium stops resolving
// names itself, so both holes close in one place.
//
// What is NOT covered here: that Chromium honours --proxy-server and
// --proxy-bypass-list=<-loopback>. Launching Chromium in a unit test is
// neither cheap nor hermetic, so those two flags are verified by reading
// them in generic.ts. What IS covered is the thing the flags point at - that
// this proxy refuses the addresses and ports the policy refuses, over both a
// plain request and a CONNECT tunnel (which is how https and WebSockets
// arrive), and that it dials the address it checked rather than re-resolving.
//
// No outbound network: the only destination is a loopback fixture.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startRenderProxy, type RenderProxy } from "../../src/lib/monitoring/render-proxy";

/** A board the proxy is told to dial, on a port the policy allows. The
 *  fixture answers on loopback; a resolve override is what connects the two,
 *  which is also what proves the dialled address came from the check. */
const WEB_PORT = 8080;

let origin: http.Server | null = null;
let originListening = false;

before(async () => {
  origin = http.createServer((req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`host=${req.headers.host ?? ""}`);
    } else res.end("plain");
  });
  originListening = await new Promise<boolean>((resolve) => {
    origin!.once("error", () => resolve(false));
    origin!.listen(WEB_PORT, "127.0.0.1", () => resolve(true));
  });
});

after(() => {
  origin?.closeAllConnections();
  origin?.close();
});

/** A raw request through the proxy in the absolute form a proxy receives. */
function throughProxy(port: number, absoluteUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(absoluteUrl);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: absoluteUrl,
        headers: { host: target.host },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A CONNECT through the proxy: how https, and a proxied WebSocket, arrive. */
function tunnelThroughProxy(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let seen = "";
    socket.on("data", (chunk) => {
      seen += chunk.toString();
      if (seen.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(seen.split("\r\n")[0]);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(seen.split("\r\n")[0] ?? ""));
  });
}

test("the real policy refuses internal addresses and non-web ports, both ways out", { timeout: 15000 }, async () => {
  const proxy = await startRenderProxy();
  try {
    // A popup to loopback is the attack the per-page interception never saw.
    const loopback = await throughProxy(proxy.port, "http://127.0.0.1:8080/");
    assert.equal(loopback.status, 403);

    // Cloud metadata, which is neither private nor loopback and so is the
    // address BLOCKED_V4 exists for.
    assert.equal((await throughProxy(proxy.port, "http://169.254.169.254:80/latest/meta-data/")).status, 403);
    assert.equal((await throughProxy(proxy.port, "http://10.0.0.5:80/")).status, 403);

    // A web port is not enough on its own, and a non-web port is refused
    // before anything is even resolved.
    assert.equal((await throughProxy(proxy.port, "http://93.184.216.34:6379/")).status, 403);

    // The CONNECT path carries https and WebSockets. ws://127.0.0.1:9200
    // from page script arrives as a tunnel request, not as an HTTP request.
    assert.match(await tunnelThroughProxy(proxy.port, "127.0.0.1:443"), /403/);
    assert.match(await tunnelThroughProxy(proxy.port, "192.168.1.1:8443"), /403/);
    assert.match(await tunnelThroughProxy(proxy.port, "93.184.216.34:9200"), /403/, "a tunnel to a non-web port");

    assert.ok(proxy.refused() >= 7, `counted ${proxy.refused()} refusals`);
  } finally {
    await proxy.close();
  }
});

test("it dials the address it checked, so a second lookup has nothing to lie in", { timeout: 15000 }, async (t) => {
  if (!originListening) {
    t.skip(`port ${WEB_PORT} is in use on this machine, so the forwarding half cannot be exercised`);
    return;
  }
  // `.invalid` can never resolve through any real resolver (RFC 2606), so a
  // request to it that ARRIVES at the loopback fixture can only have been
  // dialled with the address the checked lookup returned. That is the
  // property the browser path was missing: Chromium resolved the name again
  // for itself, and a hostile DNS server answers the second lookup
  // differently from the first.
  const proxy = await startRenderProxy({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    allowed: () => true,
  });
  try {
    const answer = await throughProxy(proxy.port, `http://board.invalid:${WEB_PORT}/hello`);
    assert.equal(answer.status, 200);
    assert.equal(answer.body, `host=board.invalid:${WEB_PORT}`, "the Host header the page meant is the one sent");
    assert.equal(proxy.refused(), 0);

    // And the tunnel half reaches the same fixture.
    assert.match(await tunnelThroughProxy(proxy.port, `board.invalid:${WEB_PORT}`), /200/);
  } finally {
    await proxy.close();
  }
});

test("a refusal is one failed request, not a dead proxy", { timeout: 15000 }, async (t) => {
  if (!originListening) {
    t.skip(`port ${WEB_PORT} is in use on this machine`);
    return;
  }
  // A hostile page makes many requests. The one that is refused must not take
  // the crawl's render with it - the board still has to be readable.
  const proxy: RenderProxy = await startRenderProxy({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    allowed: (a) => a.address === "127.0.0.1",
  });
  try {
    assert.equal((await throughProxy(proxy.port, "http://10.1.2.3:8080/")).status, 403, "a literal is judged as itself");
    const after = await throughProxy(proxy.port, `http://board.invalid:${WEB_PORT}/hello`);
    assert.equal(after.status, 200, "the next request still works");
  } finally {
    await proxy.close();
  }
});

test("the proxy stops listening when it is closed", { timeout: 15000 }, async () => {
  // monitor-run.ts ends with process.exit, but a listening socket keeps the
  // process alive before it gets there - the same reason the browser has to
  // be closed explicitly.
  const proxy = await startRenderProxy();
  const { port } = proxy;
  await proxy.close();
  await assert.rejects(throughProxy(port, "http://93.184.216.34:80/"));
});
