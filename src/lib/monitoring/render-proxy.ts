import "server-only";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { BlockedAddressError, WEB_PORTS, checkedAddresses, type Resolved, type Resolver } from "./safe-fetch";

/**
 * The address check, moved to where Chromium actually resolves names.
 *
 * WHY THE PAGE-LEVEL CHECK WAS NOT ENOUGH
 * ---------------------------------------
 * The rendered crawl in connectors/generic.ts already calls assertPublicUrl
 * before it navigates, and again for every request its one instrumented tab
 * reports. Two things slip through that, and both were found in the security
 * review of 6 October 2026.
 *
 * DNS rebinding. assertPublicUrl resolves the name with Node's resolver and
 * then calls req.continue(); Chromium goes on to resolve the same name itself
 * when it connects. That is two lookups for one decision, which is the exact
 * shape pinnedFetch exists to remove on the static path - a hostile
 * authoritative server answers "public" to the lookup that is CHECKED and
 * 127.0.0.1 to the lookup that is USED. The static path pins by handing the
 * socket its own lookup; the browser path had nothing equivalent, because
 * nothing in puppeteer.launch({headless:true}) constrains where Chromium
 * dials.
 *
 * Everything that is not that tab's HTTP requests. CDP request interception
 * is attached to one Page. A popup from window.open is a different target
 * with a different Page and no interception (Puppeteer's default Chromium
 * args include --disable-popup-blocking), and a WebSocket handshake is not
 * reported through the Fetch domain at all. So a hostile careers page - and
 * these are pages the crawler does not own, reached from scraped links - had
 * two routes to any address and any port on the crawl host's network while
 * the tab's own fetches were being dutifully refused.
 *
 * WHAT THIS IS
 * ------------
 * A proxy on loopback that Chromium is pointed at with --proxy-server, which
 * makes it the only way out of the browser: proxy settings are per-profile,
 * not per-tab, so popups, workers, subresources and WebSocket tunnels all
 * arrive here. Chromium stops resolving names when it has a proxy - it sends
 * the NAME - so this process does the resolving, checks the addresses, and
 * dials the address it checked. Same property as pinnedFetch, same reason.
 *
 * TLS is untouched. A CONNECT is tunnelled as raw bytes, so the handshake,
 * the certificate check and SNI are all still between Chromium and the real
 * host; this never sees inside an https response and holds no certificate of
 * its own.
 *
 * Launch it with --proxy-bypass-list=<-loopback> or this is theatre: Chromium
 * bypasses the proxy for localhost and 127.0.0.1 by default, which is the one
 * destination the check most wants to refuse.
 *
 * It listens on 127.0.0.1 on an ephemeral port and forwards only to public
 * addresses on web ports, so anything else on the machine that found it could
 * reach no more than it already can.
 */

export type RenderProxy = {
  /** The loopback port to point --proxy-server at. */
  port: number;
  /** Connections the policy refused, for the crawl log. */
  refused(): number;
  close(): Promise<void>;
};

/** Headers that belong to the hop, not to the request, and must not be passed
 *  on. `proxy-connection` is the one Chromium adds for a proxy specifically. */
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

/** The address to dial for a name, or a BlockedAddressError. Shared by both
 *  halves of the proxy so a CONNECT and a plain GET cannot drift. */
async function pinned(
  hostname: string,
  port: number,
  test: { resolve?: Resolver; allowed?: (a: Resolved) => boolean },
): Promise<Resolved> {
  // Ports first: it is the cheapest check and the one that rules out probing
  // internal services on 22, 3306 or 6379 whatever they resolve to.
  if (!WEB_PORTS.has(port)) throw new BlockedAddressError(`port ${port} is not a web port`);
  const addresses = await checkedAddresses(hostname, test.resolve, test.allowed);
  return addresses[0];
}

export async function startRenderProxy(
  test: { resolve?: Resolver; allowed?: (a: Resolved) => boolean } = {},
): Promise<RenderProxy> {
  let refused = 0;
  const sockets = new Set<net.Socket>();

  const server = http.createServer();

  /**
   * Plain http, which a proxy receives in absolute form
   * ("GET http://host/path HTTP/1.1"). Replayed to the checked address with
   * setHost:false so the Host header the page meant is the one that is sent.
   */
  server.on("request", (req, res) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        // Not absolute-form, so not a proxy request. Nothing here serves content.
        res.writeHead(400).end();
        return;
      }
      try {
        if (url.protocol !== "http:") throw new BlockedAddressError(`scheme ${url.protocol} is not http`);
        const port = url.port ? Number(url.port) : 80;
        const target = await pinned(url.hostname, port, test);
        const headers: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
          headers[key] = value;
        }
        const upstream = http.request(
          {
            host: target.address,
            family: target.family,
            port,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers,
            setHost: false,
          },
          (answer) => {
            // Hop-by-hop headers are stripped on the way back as well:
            // passing a `transfer-encoding` through to a response Node is
            // about to frame itself produces a body neither end agrees on.
            const back: Record<string, string | string[]> = {};
            for (const [key, value] of Object.entries(answer.headers)) {
              if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
              back[key] = value;
            }
            res.writeHead(answer.statusCode ?? 502, back);
            answer.pipe(res);
          },
        );
        upstream.on("error", () => res.destroy());
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      } catch {
        refused += 1;
        res.writeHead(403).end();
      }
    })();
  });

  /**
   * CONNECT, which is https and - when Chromium has a proxy - WebSockets too.
   * Tunnelled byte for byte once the address passes, so the browser's own TLS
   * is end to end.
   */
  server.on("connect", (req, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    void (async () => {
      const authority = req.url ?? "";
      // "host:port", with an IPv6 literal in brackets.
      const split = authority.lastIndexOf(":");
      const host = split === -1 ? authority : authority.slice(0, split);
      const port = split === -1 ? 443 : Number(authority.slice(split + 1));
      try {
        if (!Number.isInteger(port)) throw new BlockedAddressError(`${authority} has no port`);
        const target = await pinned(host, port, test);
        const upstream = net.connect({ host: target.address, port, family: target.family });
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        upstream.on("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
      } catch {
        refused += 1;
        // A 403 on the tunnel is what a page sees as a failed connection,
        // which is an ordinary thing on the web and not a crash.
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    refused: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        // Tunnels are long-lived by nature, so they are torn down rather than
        // waited for - otherwise the crawl process never exits.
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
