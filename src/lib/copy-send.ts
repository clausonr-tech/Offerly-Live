// When copying an email out of the composer counts as sending it.
//
// Its own module, with no imports, so the composer (a client component) and
// the tests can share the one rule.

/**
 * How much of the body a copy has to take to count as sending the email.
 *
 * Cmd+C on the whole email is a send; Cmd+C on one sentence, to reuse it
 * somewhere else, is not. Most of the body rather than all of it, because a
 * selection dragged by hand routinely misses the last line or the sign-off.
 */
export const SEND_COPY_SHARE = 0.8;

/** Line endings as one character, so a body saved with \r\n and the same text
 *  copied with \n measure the same. */
const normalise = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/**
 * Whether copying `selected` out of an email whose body is `body` is sending it.
 *
 * It has to BE the body - most of it, and nothing that is not in it. Length
 * alone let a long subject line, copied on its own, count as sending a short
 * email.
 */
export function copyCountsAsSend(selected: string, body: string): boolean {
  const whole = normalise(body);
  const taken = normalise(selected);
  if (!whole || !taken) return false;
  if (!whole.includes(taken)) return false;
  return taken.length >= whole.length * SEND_COPY_SHARE;
}
