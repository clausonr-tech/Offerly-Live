// Shared between the server action and the client composer. Lives on its own
// rather than in lib/people.ts because that module is "server-only" - importing
// the constant from there would drag the whole messaging query layer, and the
// database client, into the browser bundle.
export const MESSAGE_MAX = 2000;

/** How long after sending a message its sender can still change it. After
 *  that it stands as written: the other person may already have acted on it. */
export const MESSAGE_EDIT_WINDOW_MS = 10 * 60_000;

/**
 * Whether a message sent at `createdAt` can still be edited at `now`. No lower
 * bound: created_at is the database's clock and `now` the app server's, so a
 * message sent a moment ago can read as a few seconds in the future.
 */
export function canEditMessage(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() < MESSAGE_EDIT_WINDOW_MS;
}
