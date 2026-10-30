import "server-only";

import { decodeEntities } from "../html-entities";

/**
 * HTML to text, keeping the structure a job posting is written in.
 *
 * The connectors used to do this inline, as
 *
 *     decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ")
 *
 * and those two replaces are why a stored posting is one unbroken line. The
 * first turns `</li><li>` into a single space, so every item of a
 * qualifications list is welded to the next; the second flattens whatever
 * newlines were left. By the time it reaches the database the information that
 * the firm wrote a list is simply gone, and no amount of work at render time
 * can get it back - "...June 2029 Relevant internship experience" has no
 * boundary left in it to find.
 *
 * So the block-level tags become newlines and list items become bullets BEFORE
 * the remaining tags are stripped, and only horizontal whitespace is collapsed
 * afterwards. Titles and table cells still want the old flattened behaviour,
 * which this deliberately does not do.
 */

const BLOCK_END =
  /<\/(?:p|div|section|article|h[1-6]|tr|table|ul|ol|blockquote|dd|dt|dl|figure|pre)\s*>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;
const DROPPED = /<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi;

export function htmlToText(html: string): string {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(DROPPED, " ")
      .replace(LINE_BREAK, "\n")
      .replace(LIST_ITEM, "\n• ")
      .replace(BLOCK_END, "\n")
      // Everything else - <b>, <a>, <span> - is inline, so it becomes a space
      // rather than a break, exactly as before.
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t   ]+/g, " ")
    // A bullet left empty by a list item that held only markup is noise.
    .replace(/^[ \t]*•[ \t]*$/gm, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
