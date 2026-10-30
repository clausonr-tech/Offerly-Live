/**
 * Whether the navigation rail is retracted, as a cookie.
 *
 * A cookie rather than localStorage, and read on the SERVER, for the same
 * reason the theme is: the first painted HTML has to already carry the right
 * width. Restored from localStorage in an effect, the rail would render at
 * 15rem, then snap to 4.25rem after hydration - a visible lurch of the whole
 * page on every single load, since the content's left padding moves with it.
 *
 * Its own leaf module with no imports, because the two things that need it
 * cannot import each other: the client component that writes it, and the
 * server layout that reads it. A constant exported from a "use client" module
 * arrives `undefined` in a server component, silently - the same trap
 * lib/post-limits.ts and lib/message-limits.ts exist to avoid.
 */

export const RAIL_COOKIE = "sidebar-rail";

export type RailState = "open" | "collapsed";

/** Anything other than an explicit "collapsed" means open - a new visitor, a
 *  cleared cookie or a corrupted value all get the full rail, which is the
 *  state that explains itself. */
export function parseRailState(value: string | undefined): RailState {
  return value === "collapsed" ? "collapsed" : "open";
}

/** A year, so the choice survives. Lax rather than Strict: this is a display
 *  preference, and it should still apply when the app is opened from a link
 *  someone was sent. */
export function railCookieString(state: RailState): string {
  return `${RAIL_COOKIE}=${state}; path=/; max-age=31536000; samesite=lax`;
}
