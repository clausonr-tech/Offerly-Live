import { NextResponse } from "next/server";
import { readResumeFile } from "@/lib/resume-storage";
import { resolveResumeShareLink } from "@/lib/resume-share";

/**
 * Serves a student's resume to whoever holds the link.
 *
 * Deliberately unauthenticated: the whole point is that a banker who received
 * a cold email can open it without an Offerly account. The token is the only
 * credential, which is why it is random, expires, and can be turned off or
 * replaced by the student - see lib/resume-share, which owns all of that. This
 * route only decides what to send back.
 *
 * Inline rather than as an attachment - a recruiter clicking a link expects to
 * read it, not to download something.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  try {
    const link = await resolveResumeShareLink(token);
    // An expired link gets a plain sentence rather than a 404: whoever was
    // sent it should be able to tell "this link has run out" from "there is
    // no such person", and ask the student for a current one.
    if (link.status === "expired") {
      return new NextResponse("This resume link has expired. Ask the person who sent it for a current link.", {
        status: 410,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
      });
    }
    if (link.status === "throttled") {
      return new NextResponse("This resume link has been opened too many times just now. Try again shortly.", {
        status: 429,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "600" },
      });
    }
    if (link.status !== "ok") return new NextResponse("Not found", { status: 404 });

    const bytes = await readResumeFile(link.storageKey);
    if (!bytes) return new NextResponse("Not found", { status: 404 });
    const isPdf = (link.filename ?? "").toLowerCase().endsWith(".pdf");
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": isPdf ? "application/pdf" : "application/octet-stream",
        "Content-Disposition": `inline; filename="${(link.filename ?? "resume").replace(/"/g, "")}"`,
        // A shared resume is replaced as the student iterates on it; a cached
        // copy would keep serving last month's version - and a link that has
        // been turned off must not be served from anyone's cache.
        "Cache-Control": "no-store",
        // The file is reachable by anyone with the link; keep it out of indexes.
        "X-Robots-Tag": "noindex, nofollow",
        // Served as the type above and nothing else - a non-PDF upload must
        // never be sniffed into something the browser runs.
        "X-Content-Type-Options": "nosniff",
        // A student uploaded this file and the link needs no account, so it is
        // the least-trusted serving path. Sandbox it to a unique origin with no
        // script so a crafted upload cannot run as a page on Offerly's origin.
        // Same policy as the firm resume route.
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
