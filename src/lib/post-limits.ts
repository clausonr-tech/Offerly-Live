// Deliberately its own module, with no "server-only" and no imports.
//
// The limit is needed in two places that cannot import each other: the server
// action that enforces it, and the textarea that shows the remaining count.
// lib/activity.ts is marked server-only, so a client component importing the
// constant from there fails the build - and putting it in the client component
// instead is the mirror-image trap (a constant exported from a "use client"
// module arrives `undefined` in a server component, silently). A leaf module
// both sides can import is the only arrangement that works in both directions.
//
// Same reasoning, same shape as lib/message-limits.ts.
export const POST_BODY_MAX = 600;

/** The longest headline a post can carry. Short on purpose: a title is a
 *  label for the post, and one that wraps to three lines in a feed card is
 *  doing the body's job. */
export const POST_TITLE_MAX = 120;

/**
 * How many posts one account may publish in a day, and how many of those may
 * carry an image.
 *
 * A post is a row every other student is served, and an attached image is up
 * to 4MB of bytea in the shared database that nothing else was ever going to
 * delete - so the feed is both the loudest shared surface in the app and its
 * largest per-request write. These are the bound on both. Daily rather than
 * hourly on purpose: a student posting through a busy recruiting day should
 * never meet a wall, and the number that matters for storage is the one per
 * day, not per hour.
 *
 * Generous: twelve posts a day is more than anyone writes, and the image
 * allowance caps one account at well under a gigabyte a year.
 */
export const POSTS_PER_DAY = 40;
export const POST_IMAGES_PER_DAY = 12;
export const POST_DAY_MS = 24 * 60 * 60_000;
