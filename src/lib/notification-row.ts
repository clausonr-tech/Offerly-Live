// How one job under the bell reads as a single line.
//
// The dropdown shows each job as one line: what to do on the left, the firm it
// is about muted on the right, then the tick-off button. Everything the line
// drops (the detail sentence and how long ago it fired) moves into the
// tooltip, so nothing is lost, and the full /notifications page still shows
// all of it.
//
// Pure so the rule can be tested without a browser.

export type BellRowInput = {
  title: string;
  body?: string | null;
  /** Relative age as the slot formats it: "10m", "3d", "just now". */
  when?: string | null;
  /**
   * The firm, when the caller knows it as a field. Nothing supplies it today:
   * the notifications table has no firm column, so the one kind that names a
   * firm outside its title (a follow-up) has it read back out of its detail
   * line instead. A caller that does know it should pass it; it always wins.
   */
  firm?: string | null;
};

export type BellRow = {
  /** Never empty, never more than one line of text. */
  title: string;
  /** Null when unknown, or when the title already names it. */
  firm: string | null;
  /** Title, detail and age, one per line. */
  tooltip: string;
};

/** What a job says when it arrives with no words at all. */
export const UNTITLED_JOB = "Something to do";

/** One line: every run of whitespace (newlines, tabs, NBSP) becomes one space.
 *  Zero-width joiners are not whitespace and stay - they hold emoji and some
 *  scripts together. */
function oneLine(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function comparable(s: string): string {
  return s.normalize("NFKC").toLocaleLowerCase();
}

// The follow-up detail line, as prompt-flash.ts writes it:
//   "2nd email · Goldman Sachs · no reply since 14 Sep"
//   "2nd email · no reply since 14 Sep"            (no firm on the contact)
// Only that exact shape yields a firm. The other kinds either put the firm in
// the title ("Email Evercore", "Prep for Lazard") or never name one.
const SEP = " · ";
const RUNG = /^\d+(st|nd|rd|th) email$/i;
const SILENCE = /^no reply since /i;

/** The firm named in a follow-up's detail line, or null. */
export function firmFromDetail(body: string | null | undefined): string | null {
  const parts = oneLine(body).split(SEP);
  if (parts.length < 3) return null;
  if (!RUNG.test(parts[0]) || !SILENCE.test(parts[parts.length - 1])) return null;
  // A firm with " · " in its own name keeps it.
  const firm = oneLine(parts.slice(1, -1).join(SEP));
  return firm || null;
}

export function bellRow(input: BellRowInput): BellRow {
  const body = oneLine(input.body);
  const title = oneLine(input.title) || body || UNTITLED_JOB;

  const given = oneLine(input.firm);
  let firm: string | null = given || firmFromDetail(body);
  // "Email Evercore" beside "Evercore" says the same word twice.
  if (firm && comparable(title).includes(comparable(firm))) firm = null;

  const when = oneLine(input.when);
  const tooltip = [
    title,
    body && body !== title ? body : "",
    when ? (when === "just now" ? when : `${when} ago`) : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { title, firm, tooltip };
}
