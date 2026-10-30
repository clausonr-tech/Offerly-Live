import "server-only";
import { headers } from "next/headers";

/**
 * Where this request was served from - "https://offerly.app" - for links in
 * emails sent while handling it. APP_URL wins when set. Without it, the Host
 * header is trusted only outside production: a client can send any Host (or
 * X-Forwarded-Host), and a link in an email built from it would point
 * wherever the sender chose. Null outside a request, or in production with no
 * APP_URL.
 */
export async function requestOrigin(): Promise<string | null> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") return null;
  try {
    const h = await headers();
    const host = h.get("host");
    if (!host) return null;
    return `${host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https"}://${host}`;
  } catch {
    return null;
  }
}
