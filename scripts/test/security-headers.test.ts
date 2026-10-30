import assert from "node:assert/strict";
import test from "node:test";

import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import loadCustomRoutes from "next/dist/lib/load-custom-routes";

import nextConfig from "../../next.config";

/**
 * The baseline browser headers, read from the exported Next config and run
 * through Next's own route loader and matcher - the same validation
 * `next build` applies - so a header rule that stops covering a route, a
 * duplicated key or a softened value fails here rather than in a scan.
 */

const REQUIRED: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

const ROUTES = [
  "/",
  "/dashboard",
  "/login",
  "/networking/clubs",
  "/discovery/firm/some-firm",
  "/api/anything",
  "/_next/static/chunks/app.js",
];

/** Every header Next would send for `pathname`, keyed lower-case, in order. */
async function headersFor(pathname: string) {
  const { headers } = await loadCustomRoutes(nextConfig);
  const sent: { key: string; value: string }[] = [];
  for (const rule of headers) {
    // The regex `next build` writes to routes-manifest.json for this rule.
    const { regex } = buildCustomRoute("header", rule);
    if (new RegExp(regex).test(pathname)) sent.push(...rule.headers);
  }
  return sent.map((h) => ({ key: h.key.toLowerCase(), value: h.value }));
}

function directives(policy: string) {
  const map = new Map<string, string[]>();
  for (const part of policy.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    assert.ok(!map.has(name.toLowerCase()), `CSP directive ${name} repeated`);
    map.set(name.toLowerCase(), values);
  }
  return map;
}

test("X-Powered-By is switched off", () => {
  assert.equal(nextConfig.poweredByHeader, false);
});

test("the header rules pass Next's own validation", async () => {
  await assert.doesNotReject(loadCustomRoutes(nextConfig));
});

for (const route of ROUTES) {
  test(`every required header is sent once, with its value, on ${route}`, async () => {
    const sent = await headersFor(route);
    const keys = sent.map((h) => h.key);
    assert.deepEqual(keys, [...new Set(keys)], `duplicate header keys on ${route}: ${keys}`);

    const get = (key: string) => sent.find((h) => h.key === key)?.value;
    for (const [key, value] of Object.entries(REQUIRED)) assert.equal(get(key), value, key);

    const permissions = get("permissions-policy");
    assert.ok(permissions, "Permissions-Policy missing");
    // Geolocation off entirely. Camera and microphone for this origin only
    // (the video interview) - never for embedded third parties.
    assert.match(permissions, /(^|,\s*)geolocation=\(\)(\s*,|$)/, "geolocation not disabled");
    for (const feature of ["camera", "microphone"]) {
      assert.match(permissions, new RegExp(`(^|,\\s*)${feature}=\\(self\\)(\\s*,|$)`), `${feature} not limited to self`);
    }

    assert.ok(get("content-security-policy-report-only"), "CSP report-only missing");
    assert.match(get("strict-transport-security") ?? "", /max-age=\d{8,}/, "HSTS missing or short");
  });
}

test("CSP is report-only, not enforced, and not nonce-based", async () => {
  const sent = await headersFor("/");
  assert.ok(!sent.some((h) => h.key === "content-security-policy"), "an enforcing CSP is set");

  const policy = sent.find((h) => h.key === "content-security-policy-report-only")!.value;
  assert.doesNotMatch(policy, /'nonce-|'strict-dynamic'/);

  const csp = directives(policy);
  for (const name of ["default-src", "base-uri", "object-src", "frame-ancestors", "form-action"]) {
    assert.ok(csp.has(name), `CSP missing ${name}`);
  }
  assert.deepEqual(csp.get("object-src"), ["'none'"]);
  assert.deepEqual(csp.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(csp.get("base-uri"), ["'self'"]);
  assert.deepEqual(csp.get("form-action"), ["'self'"]);
  assert.deepEqual(csp.get("default-src"), ["'self'"]);
});

test("the existing image, server-action and redirect settings are kept", async () => {
  assert.deepEqual(nextConfig.images, { unoptimized: true });
  // Uploads are capped at 4MB (lib/file-store.ts), under Vercel's 4.5MB body limit.
  assert.equal(nextConfig.experimental?.serverActions?.bodySizeLimit, "4.4mb");
  const redirects = await nextConfig.redirects!();
  assert.deepEqual(redirects, [
    { source: "/home", destination: "/dashboard", permanent: false },
    { source: "/feed", destination: "/networking", permanent: false },
    { source: "/feed/:path*", destination: "/networking/:path*", permanent: false },
  ]);
});
