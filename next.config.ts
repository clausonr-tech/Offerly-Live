import type { NextConfig } from "next";

// Report-only for now: browsers log what this policy would block without
// blocking it, so it can be tuned against real pages before anything enforces
// it. Not nonce-based - Next's inline bootstrap scripts need 'unsafe-inline'
// until a nonce is threaded through the proxy. Firm logos load from outside
// hosts (discovery/FirmLogo.tsx), hence https: for images. The market charts
// on Finance News are TradingView's widgets: its script, and the frames it
// draws them in (news/TradingViewWidget.tsx).
export const CONTENT_SECURITY_POLICY_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://s3.tradingview.com https://widgets.tradingview-widget.com",
  "frame-src https://*.tradingview.com https://*.tradingview-widget.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join("; ");

// Sent on every route. The test in scripts/test/security-headers.test.ts
// holds these values in place. The anti-framing half of the CSP is enforced
// already, through X-Frame-Options.
export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Camera and microphone for this origin only - Interview Prep's video
  // interview records from them (learn/video). Site-wide rather than on that
  // route: a Permissions-Policy binds to the document as first loaded, and a
  // tab click is a client-side navigation, so a student who opened the app on
  // any other page would find the camera blocked. Embedded third-party
  // content stays denied, and the browser still asks the student first.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: CONTENT_SECURITY_POLICY_REPORT_ONLY },
  // HTTPS only, for two years, once a browser has seen the site over HTTPS
  // (browsers ignore it on plain http, so local development is unaffected).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  agentRules: false,
  // The X-Powered-By: Next.js header only tells a scanner what to try.
  poweredByHeader: false,
  // A second dev server (a separate test database, say) needs its own build
  // folder: Next locks .next/dev, so two servers cannot share one.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@electric-sql/pglite"],
  // Nothing renders next/image, so the /_next/image optimizer serves no page -
  // but it stays reachable unless switched off, and it is the component
  // GHSA-2xp9-vwfh-vxw4 (unauthenticated RCE via AVIF) lived in. Off until an
  // image actually needs optimizing.
  images: { unoptimized: true },
  experimental: {
    // Resumes and images upload through server actions, capped at 4MB each
    // (lib/file-store.ts) - the 1MB default would reject many. Just above the
    // cap for the form's other fields, and under Vercel's 4.5MB request limit.
    serverActions: { bodySizeLimit: "4.4mb" },
  },

  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },

  // Routes that moved, kept working rather than 404ing.
  //
  // /home was the signed-in landing page - the scroll hero with the offer
  // letter typing itself out. Opportunities is the landing page now, so the
  // hero is no longer on the path between signing in and working. Its code is
  // still in the repo, parked at src/app/(app)/_home; the leading underscore
  // makes it a Next.js private folder, which is excluded from routing. Move
  // it back to `home` to bring the route online again.
  //
  // /feed was Community, which is now part of Networking - the wildcard
  // carries the children, so a bookmarked /feed/clubs lands on
  // /networking/clubs rather than nowhere.
  //
  // All temporary (308 vs 307) on purpose. A permanent redirect is cached by
  // the browser indefinitely, so restoring either route later would leave
  // anyone who had visited it stuck on the new destination with no way to
  // clear it but their own site data.
  async redirects() {
    return [
      { source: "/home", destination: "/dashboard", permanent: false },
      { source: "/feed", destination: "/networking", permanent: false },
      { source: "/feed/:path*", destination: "/networking/:path*", permanent: false },
    ];
  },
};

export default nextConfig;
