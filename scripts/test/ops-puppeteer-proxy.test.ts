/**
 * Every operator script that opens a real browser opens it behind the
 * filtering proxy.
 *
 * The crawler's rendered path was fixed first: connectors/generic.ts launches
 * Chromium with `--proxy-server` pointed at lib/monitoring/render-proxy.ts and
 * `--proxy-bypass-list=<-loopback>`, so Chromium stops resolving names itself
 * and every request - popups, workers, subresources, CONNECT tunnels - goes
 * through one address check. That closed a DNS-rebinding window: a page-level
 * check resolves a name and then lets the browser resolve it again, and the
 * address checked is not the address dialled.
 *
 * These three scripts render pages reached from third-party careers sites,
 * sitemap and robots links, and a seed file of firm domains - on the operator's
 * own laptop, where an internal address is a home router, a dev server, or
 * whatever else is listening - and each launched Chromium with no proxy at all.
 *
 * Asserted at the source, the way firm-portal-privacy.test.ts asserts a page
 * rule: the alternative is launching three real browsers in a test run, and the
 * thing worth pinning is the LAUNCH FLAGS, which are a property of the text.
 *
 * `--no-sandbox` is checked here too. find-firm-logos.ts passed it
 * unconditionally for the sake of the container that cannot keep the sandbox,
 * which took Chromium's sandbox away from every ordinary operator run as well.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(__dirname, "..");

/** The scripts that open a browser. Add one here when you add one there. */
const RENDERING_SCRIPTS = ["discover-boards.ts", "discover-boards-deep.ts", "find-firm-logos.ts"];

const read = (name: string) => fs.readFileSync(path.join(ROOT, name), "utf8");

/** Every `puppeteer.launch(` in the file, and the text of its arguments. A
 *  launch is only safe if ITS OWN args carry the proxy, so they are counted
 *  rather than searched for anywhere in the file. */
function launches(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/puppeteer\.launch\(/g)) {
    // From the call to the end of its argument object, by brace balance.
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(" || src[i] === "{") depth += 1;
      else if (src[i] === ")" || src[i] === "}") depth -= 1;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

test("every operator browser launch goes through the render proxy", () => {
  for (const name of RENDERING_SCRIPTS) {
    const src = read(name);
    const calls = launches(src);
    assert.ok(calls.length > 0, `${name}: expected a puppeteer.launch to check`);

    for (const args of calls) {
      assert.match(
        args,
        /--proxy-server=/,
        `${name}: a launch with no --proxy-server - Chromium resolves names itself and dials what comes back`,
      );
      assert.match(
        args,
        /--proxy-bypass-list=<-loopback>/,
        `${name}: without the bypass list Chromium skips the proxy for localhost, the one address the check most wants to refuse`,
      );
      assert.match(
        args,
        /env:/,
        `${name}: the browser child must not inherit this process's environment (it holds .env.local)`,
      );
    }

    // The proxy is this file's own, started for the browser it serves.
    assert.match(
      src,
      /startRenderProxy|startFilteringProxy/,
      `${name}: expected lib/monitoring/render-proxy to be the proxy, not a second implementation`,
    );
  }
});

test("the proxy is torn down with the browser, never left listening", () => {
  for (const name of RENDERING_SCRIPTS) {
    const src = read(name);
    // Two closes, both of which have to be there: a browser left running keeps
    // the process alive, and so does the proxy's listening socket.
    assert.match(src, /proxy\??\.close\(\)/, `${name}: the proxy is never closed`);
    assert.ok(
      /(browser|b)\??\.close\(\)/.test(src) || /closeBrowser\(\)/.test(src),
      `${name}: the browser is never closed`,
    );
    // A launch that fails must not leave the proxy behind either - that path is
    // the easy one to forget, because nothing about it is visible in a good run.
    assert.ok(
      /catch[\s\S]{0,400}?proxy\??\.close\(\)/.test(src),
      `${name}: a failed launch leaves the proxy listening`,
    );
  }
});

test("find-firm-logos keeps Chromium's sandbox outside the container", () => {
  const src = read("find-firm-logos.ts");
  const calls = launches(src);
  assert.equal(calls.length, 1, "one launch in this file");
  const args = calls[0];

  assert.match(args, /--no-sandbox/, "the container case still needs it");
  // And it is behind the condition that describes that case, rather than
  // unconditional in the args list.
  assert.match(
    args,
    /containerised \? \["--no-sandbox"\]/,
    "--no-sandbox must be restricted to the CHROMIUM_PATH / HTTPS_PROXY case",
  );
  assert.ok(
    /const containerised = Boolean\(ownProxy \|\| process\.env\.CHROMIUM_PATH\)/.test(src),
    "and that case is the one the file's own comment describes",
  );
  // The operator's own egress proxy, when they set one, is still what the
  // browser is pointed at - replacing it would cut the container's only route
  // out - and it gets the bypass list too.
  assert.match(args, /ownProxy \?\?/, "HTTPS_PROXY still wins when it is set");
});

test("the crawler's own rendered path is still the pattern these follow", () => {
  // If generic.ts ever stops launching this way, these three are following a
  // pattern that no longer exists and this test should fail with it.
  const generic = fs.readFileSync(
    path.join(ROOT, "..", "src", "lib", "monitoring", "connectors", "generic.ts"),
    "utf8",
  );
  const args = launches(generic);
  assert.equal(args.length, 1);
  assert.match(args[0], /--proxy-server=http:\/\/127\.0\.0\.1:\$\{proxy\.port\}/);
  assert.match(args[0], /--proxy-bypass-list=<-loopback>/);
});
