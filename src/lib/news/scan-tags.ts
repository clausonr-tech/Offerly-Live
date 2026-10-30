// Finding tags in somebody else's markup without a regex that can be made to
// hang (security review, 10 October 2026).
//
// Feeds and homepages are parsed with patterns rather than an XML library,
// because markup in the wild is frequently not well-formed and a strict parser
// drops a whole feed over one bad ampersand. The cost of that choice is that
// the obvious patterns - `<item\b[\s\S]*?</item>`, `<link[^>]*>` - backtrack
// quadratically on markup built to defeat them: three megabytes of "<item "
// with no closing tag makes every one of half a million match starts scan to
// the end of the buffer. V8 runs a regex synchronously on the only thread, so
// the fetch timeout cannot interrupt it, and the news job holds a lock shared
// by the run, the desk and the scout - one crafted page would stop the News
// tab updating until somebody killed the process.
//
// So the structural scanning is done here with indexOf instead, which is
// linear by construction. Two facts make it so:
//
//   - a closing tag that has no occurrence after some position has none after
//     any later position either, so the scan looks for it once and then gives
//     up on that name entirely;
//   - each name's next opener is remembered, so a name that occurs late is not
//     searched for again from every position in between.
//
// Attribute values are still read with regexes, but only ever from one tag's
// attribute text, which is capped - a few hundred characters cannot be made
// expensive.

export type OpenTag = { name: string; attrs: string };

/** One tag's attribute text is never longer than this; no real attribute is. */
const ATTR_LIMIT = 4_000;

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * A case-folded copy to SEARCH, the same length as the original to SLICE.
 *
 * Every function below finds positions in a folded copy and then slices
 * `markup` with them, which is only sound while the two strings agree
 * character for character. `String.prototype.toLowerCase` does not: it is a
 * full Unicode mapping and some of its outputs are longer than their inputs.
 * U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE) lowercases to two UTF-16
 * units, so N of them anywhere earlier in a document shift every later index
 * by +N and each slice lands N characters to the right of the construct it
 * was supposed to describe - `attrs` losing the front of the real attributes
 * and picking up whatever follows the tag's `>`, which parse.ts then reads as
 * the story's image URL. A feed can simply put `İ` in a <title>.
 *
 * ASCII is all the folding this file needs: element and attribute names are
 * ASCII by the XML and HTML specs, every name the callers pass is ASCII, and
 * the regexes that read an attribute out of `attrs` already assume it. So
 * fold A-Z and nothing else, which is length-preserving by construction
 * (security review, 10 October 2026).
 */
const foldAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Whether `<name` at this point opens a tag rather than beginning a longer name. */
function opensHere(lower: string, after: number): boolean {
  const next = lower[after] ?? "";
  return next === ">" || next === "/" || isSpace(next);
}

/**
 * A scan position per name, so the earliest next opener can be picked without
 * re-searching the whole document for the names that are still far away.
 */
class Openers {
  private at = new Map<string, number>();
  private done = new Set<string>();
  constructor(
    private lower: string,
    private names: readonly string[],
  ) {}

  /** The earliest `<name` at or after `from`, or null when none is left. */
  next(from: number): { name: string; at: number } | null {
    let best: { name: string; at: number } | null = null;
    for (const name of this.names) {
      if (this.done.has(name)) continue;
      let at = this.at.get(name) ?? -1;
      if (at < from) {
        at = this.lower.indexOf(`<${foldAscii(name)}`, from);
        if (at === -1) {
          this.done.add(name);
          continue;
        }
        this.at.set(name, at);
      }
      if (!best || at < best.at) best = { name, at };
    }
    return best;
  }

  /** Stop looking for this name: nothing later can match it either. */
  giveUp(name: string): void {
    this.done.add(name);
  }
}

/**
 * Every `<name ...>` opening tag in document order, as its attribute text.
 * The caller reads the attributes it wants from a short string rather than
 * from the whole page.
 */
export function openTags(markup: string, names: readonly string[], max = 400): OpenTag[] {
  const lower = foldAscii(markup);
  const openers = new Openers(lower, names);
  const out: OpenTag[] = [];
  let from = 0;
  while (out.length < max) {
    const found = openers.next(from);
    if (!found) break;
    const after = found.at + found.name.length + 1;
    if (!opensHere(lower, after)) {
      from = found.at + 1;
      continue;
    }
    const gt = lower.indexOf(">", after);
    // An opener with no ">" after it anywhere: no later tag can close either.
    if (gt === -1) break;
    out.push({ name: found.name, attrs: markup.slice(after, Math.min(gt, after + ATTR_LIMIT)) });
    from = gt + 1;
  }
  return out;
}

/**
 * The text inside the first `<name>...</name>`, CDATA and surrounding space
 * left to the caller to unwrap. Null when the element is absent or unclosed.
 */
export function enclosedText(markup: string, name: string): string | null {
  const lower = foldAscii(markup);
  const open = `<${foldAscii(name)}`;
  const close = `</${foldAscii(name)}>`;
  let from = 0;
  for (;;) {
    const at = lower.indexOf(open, from);
    if (at === -1) return null;
    const after = at + open.length;
    // `<title/>` encloses nothing, as the old pattern also required.
    const next = lower[after] ?? "";
    if (next === ">" || isSpace(next)) {
      const gt = lower.indexOf(">", after);
      if (gt === -1) return null;
      const end = lower.indexOf(close, gt + 1);
      // No closing tag after this opener means none after a later one either.
      if (end === -1) return null;
      return markup.slice(gt + 1, end);
    }
    from = at + 1;
  }
}

/**
 * Every `<name ...>...</name>` block, tags included, in document order - the
 * feed items. A block is cut at `blockLimit`: one item's markup is never that
 * long, and the patterns that read a block then have a bounded string to work
 * on. An unclosed opener is skipped, exactly as the old pattern skipped it.
 */
export function enclosedBlocks(
  markup: string,
  names: readonly string[],
  opts: { max: number; blockLimit: number },
): string[] {
  const lower = foldAscii(markup);
  const openers = new Openers(lower, names);
  const out: string[] = [];
  let from = 0;
  while (out.length < opts.max) {
    const found = openers.next(from);
    if (!found) break;
    const after = found.at + found.name.length + 1;
    if (!opensHere(lower, after)) {
      from = found.at + 1;
      continue;
    }
    const end = lower.indexOf(`</${foldAscii(found.name)}>`, after);
    if (end === -1) {
      // Nothing later can close this name, so it is finished with.
      openers.giveUp(found.name);
      from = found.at + 1;
      continue;
    }
    const block = markup.slice(found.at, end + found.name.length + 3);
    out.push(block.length > opts.blockLimit ? block.slice(0, opts.blockLimit) : block);
    from = end + found.name.length + 3;
  }
  return out;
}

/**
 * Markup to text: every tag becomes one space. `<[^>]+>` with a global replace
 * has the same quadratic shape as the patterns above, and a description is
 * attacker-supplied like everything else in a feed.
 */
export function stripTags(markup: string): string {
  if (!markup.includes("<")) return markup;
  let out = "";
  let i = 0;
  for (;;) {
    const lt = markup.indexOf("<", i);
    if (lt === -1) return out + markup.slice(i);
    out += markup.slice(i, lt);
    const gt = markup.indexOf(">", lt + 1);
    // An unclosed opener is not a tag; the rest is text, as the pattern left it.
    if (gt === -1) return out + markup.slice(lt);
    // "<>" was never a tag to the old pattern either, which wanted a name.
    out += gt === lt + 1 ? "<>" : " ";
    i = gt + 1;
  }
}
