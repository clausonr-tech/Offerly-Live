"use client";

import { useEffect } from "react";

import { TZ_COOKIE, timeZoneCookieString } from "@/lib/time-zone";

/**
 * Tells the server which time zone this student is in.
 *
 * Renders nothing. The prompts that care about the student's own clock - an
 * interview "in the morning", a thank-you "a couple of hours after" - run on
 * the server, which only knows UTC. Written only when it changes, so a
 * student who travels is followed the next time they open the app.
 */
export default function TimeZoneCookie() {
  useEffect(() => {
    let zone: string;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!zone) return;
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${TZ_COOKIE}=`))
      ?.slice(TZ_COOKIE.length + 1);
    if (current && decodeURIComponent(current) === zone) return;
    document.cookie = timeZoneCookieString(zone);
  }, []);
  return null;
}
