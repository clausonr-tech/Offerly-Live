// What a scraped URL is allowed to reach.
//
// This is part of page analysis rather than a side concern: the generic
// connector follows listing links off pages nobody assessed, so every detail
// URL is an address chosen by a stranger's markup. Without this guard, a
// careers page could point the crawler at a cloud metadata endpoint and the
// connector would dutifully store what came back as a job description.
//
// Only literal addresses are exercised here - a hostname needs DNS, and this
// suite runs with no network. That is also the more valuable half: the bypass
// tricks are all written as literals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, BlockedAddressError } from "../../src/lib/monitoring/safe-fetch";

async function refuses(url: string): Promise<boolean> {
  try {
    await assertPublicUrl(url);
    return false;
  } catch (error) {
    return error instanceof BlockedAddressError;
  }
}

async function allows(url: string): Promise<boolean> {
  try {
    await assertPublicUrl(url);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- loopback

const loopback = [
  "http://127.0.0.1/jobs",
  "http://127.0.0.1:8080/jobs",
  "https://127.1.2.3/jobs",
  "http://127.255.255.254/",
];
for (const url of loopback) {
  test(`loopback is refused: ${url}`, async () => {
    assert.equal(await refuses(url), true);
  });
}

// --------------------------------------------------------- private networks

const privateRanges = [
  ["10.0.0.0/8", "http://10.0.0.1/jobs"],
  ["10.0.0.0/8, high", "http://10.255.255.254/"],
  ["172.16.0.0/12", "http://172.16.0.1/jobs"],
  ["172.16.0.0/12, high", "http://172.31.255.254/"],
  ["192.168.0.0/16", "http://192.168.1.1/jobs"],
  ["192.168.0.0/16, high", "http://192.168.255.254/"],
];
for (const [name, url] of privateRanges) {
  test(`a private network is refused: ${name}`, async () => {
    assert.equal(await refuses(url), true);
  });
}

test("addresses just outside the private ranges are allowed", async () => {
  // The mask arithmetic has to be right in both directions - refusing public
  // space would silently drop real boards.
  assert.equal(await allows("http://11.0.0.1/jobs"), true);
  assert.equal(await allows("http://172.15.255.254/jobs"), true);
  assert.equal(await allows("http://172.32.0.1/jobs"), true);
  assert.equal(await allows("http://192.167.255.254/jobs"), true);
  assert.equal(await allows("http://192.169.0.1/jobs"), true);
});

// ------------------------------------------------------- the metadata endpoint

test("the cloud metadata address is refused", async () => {
  // 169.254.169.254 is the one a scraped link would actually be pointed at.
  assert.equal(await refuses("http://169.254.169.254/latest/meta-data/"), true);
});

test("the whole link-local range is refused, not just the famous address", async () => {
  for (const url of ["http://169.254.0.1/", "http://169.254.255.254/"]) {
    assert.equal(await refuses(url), true, url);
  }
});

test("an IPv4-mapped IPv6 metadata address is refused", async () => {
  // The classic way round a v6 check.
  assert.equal(await refuses("http://[::ffff:169.254.169.254]/latest/meta-data/"), true);
});

test("an IPv4-mapped private address is refused", async () => {
  assert.equal(await refuses("http://[::ffff:10.0.0.1]/"), true);
  assert.equal(await refuses("http://[::ffff:127.0.0.1]/"), true);
});

// ------------------------------------------------------------------- IPv6

const blockedV6 = [
  ["unspecified", "http://[::]/"],
  ["loopback", "http://[::1]/"],
  ["unique-local fc00::/7", "http://[fc00::1]/"],
  ["unique-local fd00::", "http://[fd12:3456::1]/"],
  ["link-local fe80::/10", "http://[fe80::1]/"],
];
for (const [name, url] of blockedV6) {
  test(`IPv6 ${name} is refused`, async () => {
    assert.equal(await refuses(url), true);
  });
}

test("a link-local address with a zone index is still refused", async () => {
  // The zone is stripped before the check for exactly this reason.
  assert.equal(await refuses("http://[fe80::1%25eth0]/"), true);
});

test("a public IPv6 address is allowed", async () => {
  assert.equal(await allows("http://[2606:4700::1111]/jobs"), true);
});

// ------------------------------------------------------------- other blocks

const otherBlocked = [
  ["0.0.0.0", "http://0.0.0.0/"],
  ["broadcast", "http://255.255.255.255/"],
  ["carrier-grade NAT", "http://100.64.0.1/"],
];
for (const [name, url] of otherBlocked) {
  test(`${name} is refused`, async () => {
    assert.equal(await refuses(url), true);
  });
}

test("an unparseable address is refused, not allowed", async () => {
  // Fails closed: the default for something we could not read is no.
  for (const url of ["http://999.999.999.999/", "http://1.2.3.4.5/"]) {
    assert.equal(await allows(url), false, url);
  }
});

// --------------------------------------------------------------- schemes

const badSchemes = [
  "file:///etc/passwd",
  "ftp://example.com/jobs",
  "gopher://example.com/",
  "data:text/html,<h1>hi</h1>",
  "javascript:alert(1)",
  "mailto:careers@example.com",
];
for (const url of badSchemes) {
  test(`a non-http scheme is refused: ${url.slice(0, 28)}`, async () => {
    assert.equal(await allows(url), false, url);
  });
}

test("http and https are both allowed", async () => {
  assert.equal(await allows("http://93.184.216.34/jobs"), true);
  assert.equal(await allows("https://93.184.216.34/jobs"), true);
});

// ----------------------------------------------------------------- ports

const webPorts = [
  ["default https", "https://93.184.216.34/jobs"],
  ["default http", "http://93.184.216.34/jobs"],
  ["explicit 80", "http://93.184.216.34:80/jobs"],
  ["explicit 443", "https://93.184.216.34:443/jobs"],
  ["8080", "http://93.184.216.34:8080/jobs"],
  ["8443", "https://93.184.216.34:8443/jobs"],
];
for (const [name, url] of webPorts) {
  test(`a web port is allowed: ${name}`, async () => {
    assert.equal(await allows(url), true, url);
  });
}

const badPorts = [
  ["ssh", "http://93.184.216.34:22/"],
  ["redis", "http://93.184.216.34:6379/"],
  ["postgres", "http://93.184.216.34:5432/"],
  ["smtp", "http://93.184.216.34:25/"],
  ["memcached", "http://93.184.216.34:11211/"],
  ["elasticsearch", "http://93.184.216.34:9200/"],
];
for (const [name, url] of badPorts) {
  test(`a non-web port is refused: ${name}`, async () => {
    // A job board does not live on port 22. Restricting to the web ports
    // removes a whole class of internal-service probing for no practical cost.
    assert.equal(await refuses(url), true, url);
  });
}

// ------------------------------------------------------------- malformed

const malformed = ["", "not a url", "http://", "https://", "://example.com", "http://["];
for (const url of malformed) {
  test(`malformed input is refused rather than throwing something else: ${JSON.stringify(url)}`, async () => {
    // It must reject, and it must reject with the error the callers catch -
    // fetchStatic swallows BlockedAddressError and keeps the stub, which is
    // only correct if that is the error it gets.
    assert.equal(await allows(url), false, url);
  });
}

test("a refusal is always a BlockedAddressError", async () => {
  // fetchStatic and renderPage both rely on this: a poisoned listing URL
  // should keep its index-page stub rather than killing the run.
  for (const url of [
    "http://127.0.0.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://93.184.216.34:22/",
    "file:///etc/passwd",
  ]) {
    assert.equal(await refuses(url), true, url);
  }
});

// -------------------------------------------------------- the returned URL

test("an allowed URL comes back parsed", async () => {
  const url = await assertPublicUrl("https://93.184.216.34:8443/jobs?page=2#top");
  assert.equal(url.hostname, "93.184.216.34");
  assert.equal(url.port, "8443");
  assert.equal(url.pathname, "/jobs");
  assert.equal(url.searchParams.get("page"), "2");
});

test("a query string and fragment do not affect the decision", async () => {
  assert.equal(await refuses("http://127.0.0.1/jobs?x=1#y"), true);
  assert.equal(await allows("https://93.184.216.34/jobs?x=1#y"), true);
});

test("credentials in the URL do not smuggle a blocked host past the check", async () => {
  // "http://example.com@127.0.0.1/" resolves to 127.0.0.1, not example.com.
  assert.equal(await refuses("http://example.com@127.0.0.1/"), true);
});

test("a bracketed IPv6 host is unwrapped before the check", async () => {
  // The brackets are URL syntax, not part of the address.
  assert.equal(await refuses("http://[::1]:8080/"), true);
});

// ------------------------------------- every spelling of the same address
//
// The bypass was a TEXT match. `new URL()` normalises IPv6 before this guard
// ever sees it, so the spelling an attacker types is rarely the spelling that
// arrives - `[::ffff:169.254.169.254]` became `[::ffff:a9fe:a9fe]` and the
// dotted-quad regex written to catch it never matched.

const metadataSpellings = [
  "http://[::ffff:169.254.169.254]/latest/meta-data/",
  "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
  "http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/",
  "http://[0000:0000:0000:0000:0000:ffff:169.254.169.254]/",
  "http://[::FFFF:A9FE:A9FE]/",
];
for (const url of metadataSpellings) {
  test(`the metadata endpoint is refused however it is spelled: ${url.slice(7, 42)}`, async () => {
    assert.equal(await refuses(url), true, url);
  });
}

const loopbackSpellings = [
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/",
  "http://[0:0:0:0:0:ffff:7f00:0001]/",
  "http://[::127.0.0.1]/",
];
for (const url of loopbackSpellings) {
  test(`loopback via IPv6 is refused: ${url.slice(7, 40)}`, async () => {
    assert.equal(await refuses(url), true, url);
  });
}

const privateViaV6 = [
  "http://[::ffff:10.0.0.1]/",
  "http://[::ffff:a00:1]/",
  "http://[::ffff:192.168.1.1]/",
  "http://[::ffff:c0a8:101]/",
  "http://[::ffff:172.16.0.1]/",
];
for (const url of privateViaV6) {
  test(`a private range via IPv6 is refused: ${url.slice(7, 40)}`, async () => {
    assert.equal(await refuses(url), true, url);
  });
}

test("an address beginning :: is no longer allowed by default", async () => {
  // The precise shape of the old hole: `addr.split(":")[0]` is "" for
  // anything starting "::", and the guard for that returned "allowed".
  for (const url of ["http://[::2]/", "http://[::ffff:0:1]/", "http://[::abcd]/"]) {
    assert.equal(await allows(url), false, url);
  }
});

test("a genuinely public IPv6 address is still allowed", async () => {
  // The fix must not close the door on real boards.
  for (const url of [
    "http://[2606:4700:4700::1111]/jobs",
    "http://[2001:4860:4860::8888]/jobs",
    "http://[2a00:1450:4009:81f::200e]/jobs",
  ]) {
    assert.equal(await allows(url), true, url);
  }
});

const malformedV6 = [
  "http://[:::1]/",
  "http://[1:2:3:4:5:6:7:8:9]/",
  "http://[gggg::1]/",
  "http://[1:2:3]/",
];
for (const url of malformedV6) {
  test(`a malformed IPv6 address is refused, not allowed: ${url.slice(7, 30)}`, async () => {
    // Fails closed - unparseable is refused, the same rule IPv4 follows.
    assert.equal(await allows(url), false, url);
  });
}

test("the deprecated IPv4-compatible form is refused too", async () => {
  // `::a.b.c.d` normalises to `::7f00:1` - the same trick as `::ffff:...`
  // without the marker, and handling only the mapped form left this open.
  for (const url of [
    "http://[::127.0.0.1]/",
    "http://[::7f00:1]/",
    "http://[::169.254.169.254]/",
    "http://[::10.0.0.1]/",
  ]) {
    assert.equal(await refuses(url), true, url);
  }
});

test("the unspecified and loopback addresses still resolve as blocked", async () => {
  // They now go through the embedded-IPv4 path and are caught by 0.0.0.0/8,
  // rather than by a pair of literal string comparisons.
  assert.equal(await refuses("http://[::]/"), true);
  assert.equal(await refuses("http://[::1]/"), true);
});
