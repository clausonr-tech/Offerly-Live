import { decodeEntities } from "./html-entities";

/**
 * Turning a crawled job posting into something a student can actually read.
 *
 * What arrives is one unbroken line of several thousand characters: the firm's
 * whole page with its tags stripped and every newline collapsed, so the role
 * summary, the qualifications list, the equal-opportunity statement and the
 * cookie notice all run together in a single paragraph. 556 of 564 stored
 * postings have no line breaks left in them at all.
 *
 * This module recovers what it honestly can:
 *
 *   - entities the crawler double-encoded ("&#160;" rendered literally),
 *   - the "Title: ... Application Deadline: ..." preamble, which is dropped
 *     because the card above already shows both,
 *   - section boundaries, from a curated list of headings these postings
 *     actually use,
 *   - the requirements span, located exactly rather than guessed (see below),
 *   - bullet lists, but ONLY where a delimiter survived.
 *
 * What it deliberately does NOT do is invent bullets. "...between December 2028
 * and June 2029 Relevant internship experience (preferred) Strong
 * communications skills" is four list items with no separator of any kind
 * between them, and every rule for splitting that apart also splits "New York"
 * or "Summer Analyst". Prose that is merely unsplit is worth more than prose
 * chopped in the wrong places. The real fix for that is upstream, in the
 * connectors, which now keep <li> and <p> boundaries instead of flattening
 * them - so postings crawled from here on arrive already structured.
 *
 * Pure and isomorphic on purpose: the detail panel is a client component.
 */

type PostingBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

type PostingSection = {
  /** Null for the opening text that arrives before any recognised heading. */
  heading: string | null;
  /**
   * `boilerplate` is the firm's standing copy - who they are, equal
   * opportunity, cookies. True of nearly every posting and identical across
   * all of one firm's, so it is folded away rather than shown first.
   */
  kind: "primary" | "boilerplate";
  blocks: PostingBlock[];
};

export type FormattedPosting = {
  sections: PostingSection[];
  /** Whether any heading was recognised - used to report coverage honestly. */
  structured: boolean;
  hasBoilerplate: boolean;
  /**
   * The firm's cookie / privacy-policy line, lifted out of the text.
   *
   * On their careers pages it is a link label in the page footer, so the crawl
   * leaves it glued to whatever came last - usually the salary, which then
   * read "$115,000 View cookie / data protection and privacy policy". It is
   * kept, but shown on its own as the last line of the listing.
   */
  privacyNote: string | null;
};

type HeadingRule = {
  /** Must be global+case-insensitive; matched anywhere in the run-on text. */
  re: RegExp;
  label: string;
  kind: "primary" | "boilerplate";
};

/**
 * Headings these postings really use, most specific first.
 *
 * Order matters: "What are the Specific Qualifications?" has to win over the
 * bare "Qualifications" inside it, or the section would start four words late
 * and the heading would be left dangling at the end of the previous one.
 */
const HEADINGS: HeadingRule[] = [
  { re: /What are the Specific Qualifications\?/gi, label: "Qualifications", kind: "primary" },
  { re: /Candidates should be\/have:?/gi, label: "Qualifications", kind: "primary" },
  { re: /(?:Basic|Preferred|Minimum|Desired)\s+Qualifications:?/gi, label: "Qualifications", kind: "primary" },
  { re: /Qualifications(?:\s*(?:&|and)\s*Skills)?:?/gi, label: "Qualifications", kind: "primary" },
  { re: /(?:Primary\s+)?Duties and Responsibilities:?/gi, label: "Responsibilities", kind: "primary" },
  { re: /(?:Key\s+)?Responsibilities:?/gi, label: "Responsibilities", kind: "primary" },
  { re: /What you(?:'|’)?ll do:?/gi, label: "Responsibilities", kind: "primary" },
  { re: /Job [Dd]escription:?/g, label: "The role", kind: "primary" },
  { re: /Role [Oo]verview:?/g, label: "The role", kind: "primary" },
  { re: /Application Instructions(?: for Students)?:?/gi, label: "How to apply", kind: "primary" },
  { re: /How to [Aa]pply:?/g, label: "How to apply", kind: "primary" },
  { re: /Application Process:?/gi, label: "How to apply", kind: "primary" },
  { re: /Expected Base Salary Range:?/gi, label: "Compensation", kind: "primary" },
  { re: /(?:Compensation|Salary Range)(?: and Benefits)?:?/gi, label: "Compensation", kind: "primary" },
  { re: /Requirements:?/gi, label: "Requirements", kind: "primary" },

  { re: /Inclusion and Equal Opportunity(?:\s+Employment)?:?/gi, label: "Equal opportunity", kind: "boilerplate" },
  { re: /Equal (?:Employment )?Opportunity(?: Employer| Statement)?:?/gi, label: "Equal opportunity", kind: "boilerplate" },
  { re: /About (?:us|the (?:firm|company|team|role|program))\b:?/gi, label: "About the firm", kind: "boilerplate" },
  { re: /Privacy Policy:?/gi, label: "Privacy", kind: "boilerplate" },
];

/**
 * The cookie-notice link label. Every stored posting that carries it uses this
 * exact wording, and it can sit mid-sentence, so it is removed wherever it is
 * rather than treated as a heading (which needs a sentence start). The second
 * branch is a crawl that stopped partway through it ("View cookie / data
 * protec"), which only happens at the very end of the text.
 */
const COOKIE_NOTICE = /\s*View cookie\s*\/?\s*(?:data protection and privacy policy\.?|[a-z ]*$)/gi;
const COOKIE_NOTICE_TEXT = "View cookie / data protection and privacy policy";

function liftCookieNotice(text: string): { text: string; found: boolean } {
  COOKIE_NOTICE.lastIndex = 0;
  if (!COOKIE_NOTICE.test(text)) return { text, found: false };
  COOKIE_NOTICE.lastIndex = 0;
  return { text: text.replace(COOKIE_NOTICE, " ").replace(/[ \t]{2,}/g, " ").trim(), found: true };
}

/** Sections whose content is a list often enough to be worth splitting. */
const LIST_LIKE = new Set(["Qualifications", "Requirements", "Responsibilities"]);

function normalise(raw: string): string {
  return decodeEntities(raw)
    .replace(/\r\n?/g, "\n")
    // Horizontal whitespace only - newlines are the one piece of structure a
    // posting may still carry, and collapsing them is what caused this.
    .replace(/[ \t   ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Drop the machine preamble.
 *
 * TalentLink postings begin "Title:<role> Application Deadline:<date>", both of
 * which the card above the panel already shows. Left in, the panel opens by
 * repeating its own heading.
 */
function stripPreamble(text: string): string {
  // The date and its time have to be consumed together. Matching "the next few
  // tokens up to a capital letter" stopped at "15" and left "Nov 2026 11:55 PM
  // EST" heading the panel, because "Nov" is capitalised.
  const m =
    /^Title:\s*[\s\S]*?Application Deadline:\s*\d{1,2}\s+\w+\s+\d{4}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?(?:\s+[A-Z]{2,4})?)?/.exec(
      text,
    ) ?? /^Title:\s*[\s\S]*?Application Deadline:\s*\S+/.exec(text);
  if (m) return text.slice(m[0].length).trim();
  return text.replace(/^Title:\s*/i, "").trim();
}

type Mark = { index: number; length: number; label: string; kind: "primary" | "boilerplate" };

/**
 * Is this offset the start of a sentence?
 *
 * Only the text before it can say. A heading is preceded by nothing at all,
 * by a line break, or by the punctuation that ended the previous sentence -
 * never by "Primary Duties and", which is what "Responsibilities" was
 * matching inside.
 */
function startsSentence(text: string, index: number, match: string): boolean {
  // A heading that names itself with a colon - "Salary Range:",
  // "Qualifications:" - is a heading wherever it sits. In this stored text
  // the fields run together with no punctuation at all ("Location: New York
  // Salary Range: $135,000"), so demanding a sentence end before it threw
  // away the real headings along with the false ones.
  if (match.endsWith(":")) return true;
  const before = text.slice(0, index).replace(/[ \t]+$/, "");
  if (!before) return true;
  return /[.:;!?•\n]$/.test(before);
}

/**
 * One run-on line back into sentences.
 *
 * Split on terminal punctuation followed by something that starts a new
 * sentence. The lookahead matters: "$135,000 (pro-rated for Summer)" and
 * "Ph.D." both carry full stops that end nothing, and a naive split on "." 
 * shatters them.
 */
function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function findHeadings(text: string, firmName?: string | null): Mark[] {
  const rules = [...HEADINGS];
  if (firmName && firmName.trim()) {
    // "About Evercore" is the common form, and a generic /About \w+/ would
    // match "About the market" mid-sentence. Using the firm's own name keeps
    // it specific.
    const safe = firmName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rules.push({ re: new RegExp(`About ${safe}\\b:?`, "g"), label: "About the firm", kind: "boilerplate" });
  }

  const marks: Mark[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    // The FIRST match that begins a sentence, not simply the first match.
    //
    // These patterns are matched against one unbroken line, so a bare word
    // like "Responsibilities" hits inside running prose as readily as at the
    // head of a section. Cutting there produced the panels this was reported
    // for: a heading followed by text starting "of full-time equity research
    // professionals", because the split landed in the middle of a clause.
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      if (m[0].length === 0) break;
      if (startsSentence(text, m.index, m[0])) {
        marks.push({ index: m.index, length: m[0].length, label: rule.label, kind: rule.kind });
        break;
      }
    }
  }

  marks.sort((a, b) => a.index - b.index);

  // Drop overlaps and repeats of a label we already opened - a posting that
  // says "qualifications" again inside its own qualifications text should not
  // start a second section.
  const kept: Mark[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    const prev = kept[kept.length - 1];
    if (prev && m.index < prev.index + prev.length) continue;
    if (seen.has(m.label)) continue;
    seen.add(m.label);
    kept.push(m);
  }
  return kept;
}

function toBlocks(body: string, listLike: boolean): PostingBlock[] {
  const text = body.trim();
  if (!text) return [];

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Structure survived (a posting crawled after the connector fix, or one whose
  // source used real bullet glyphs).
  if (lines.length > 1 || /^[•·▪‣*-]\s+/.test(lines[0] ?? "")) {
    const blocks: PostingBlock[] = [];
    let items: string[] = [];
    const flush = () => {
      if (items.length) blocks.push({ type: "list", items });
      items = [];
    };
    for (const line of lines) {
      const bullet = /^[•·▪‣*-]\s+(.*)$/.exec(line);
      if (bullet) items.push(bullet[1].trim());
      else {
        flush();
        blocks.push({ type: "paragraph", text: line });
      }
    }
    flush();
    return blocks;
  }

  // One unbroken line - a posting crawled before the connector kept its
  // structure. Nothing can restore the firm's own bullets, but a wall of
  // three thousand characters is unreadable either way, so it is broken on
  // the punctuation that IS still there.
  const single = lines[0] ?? text;

  // A real delimiter first: if the source used bullets or semicolons they
  // survive, and they are better evidence than sentence endings.
  if (listLike) {
    const parts = single
      .split(/\s*[•·▪‣]\s*|\s+[-–—]\s+|\s*;\s+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 2);
    if (parts.length > 1) return [{ type: "list", items: parts }];
  }

  const sentences = toSentences(single);
  if (sentences.length < 2) return [{ type: "paragraph", text: single }];

  // A list section becomes bullets: these are duties and requirements, which
  // are a list in the firm's own posting whatever the stored text looks like.
  if (listLike) return [{ type: "list", items: sentences }];

  /**
   * Prose stays prose, in paragraphs of about three sentences.
   *
   * Bulleting "About the firm" would be worse than the wall it replaces -
   * a company description is not a list and reads as nonsense when broken
   * into one. The grouping is purely so the eye has somewhere to rest.
   */
  const paras: PostingBlock[] = [];
  for (let i = 0; i < sentences.length; i += 3) {
    paras.push({ type: "paragraph", text: sentences.slice(i, i + 3).join(" ") });
  }
  return paras;
}

export function formatPosting(input: {
  description: string;
  requirements?: string | null;
  firmName?: string | null;
}): FormattedPosting {
  const lifted = liftCookieNotice(stripPreamble(normalise(input.description ?? "")));
  const text = lifted.text;
  const privacyNote = lifted.found ? COOKIE_NOTICE_TEXT : null;
  if (!text) return { sections: [], structured: false, hasBoilerplate: false, privacyNote };

  /**
   * The requirements span is LOCATED, not guessed.
   *
   * `requirements_full` is the employer's own requirements text, captured at
   * crawl time, and in 333 of the 374 postings that have one it appears
   * verbatim inside the description. So rather than rendering it separately -
   * which would print the same paragraphs twice - it is used to find that
   * exact span and lift it into its own section. Heading detection cannot be
   * this accurate, because most postings never name the section at all.
   */
  // Lifted from the requirements too, or a span that ended with it would no
  // longer be found verbatim in the description it came from.
  const req = input.requirements ? liftCookieNotice(normalise(input.requirements)).text : "";
  let head = text;
  let tail = "";
  let requirements = "";
  if (req.length > 40) {
    const at = text.indexOf(req);
    if (at >= 0) {
      head = text.slice(0, at).trim();
      requirements = req;
      tail = text.slice(at + req.length).trim();
    } else {
      requirements = req;
    }
  }

  /**
   * `requirements_full` is captured by the crawler and is not always tightly
   * bounded - on some postings it runs on past the qualifications into "About
   * <firm>" and the equal-opportunity notice. Rendering that under a
   * "Requirements" heading would tell a student the firm's history is a
   * requirement, so the span is cut where its first boilerplate heading starts
   * and the remainder is handed back to normal section detection.
   */
  const splitRequirements = (span: string): { req: string; rest: string } => {
    // Cut at the first heading of ANY kind, not just boilerplate: these spans
    // also run on into "Application Instructions", and how-to-apply steps
    // listed as requirements read as extra things to qualify for. Headings at
    // the very start are skipped - the span usually begins immediately after
    // one ("What are the Specific Qualifications?"), and cutting there would
    // leave nothing behind.
    const marks = findHeadings(span, input.firmName).filter((m) => m.index > 24);
    if (marks.length === 0) return { req: span, rest: "" };
    const cut = marks[0].index;
    return { req: span.slice(0, cut).trim(), rest: span.slice(cut).trim() };
  };

  const build = (part: string): PostingSection[] => {
    if (!part.trim()) return [];
    const marks = findHeadings(part, input.firmName);
    if (marks.length === 0) {
      return [{ heading: null, kind: "primary", blocks: toBlocks(part, false) }];
    }
    const out: PostingSection[] = [];
    const intro = part.slice(0, marks[0].index).trim();
    if (intro) out.push({ heading: null, kind: "primary", blocks: toBlocks(intro, false) });
    marks.forEach((m, i) => {
      const from = m.index + m.length;
      const to = i + 1 < marks.length ? marks[i + 1].index : part.length;
      const body = part.slice(from, to).trim();
      if (!body) return;
      out.push({ heading: m.label, kind: m.kind, blocks: toBlocks(body, LIST_LIKE.has(m.label)) });
    });
    return out;
  };

  const sections: PostingSection[] = [...build(head)];
  if (requirements) {
    const { req, rest } = splitRequirements(requirements);
    // A leading "?" or ":" is what is left when the span starts immediately
    // after a heading like "What are the Specific Qualifications?".
    const cleaned = req.replace(/^[\s?:.,;-]+/, "").trim();
    if (cleaned) {
      sections.push({ heading: "Requirements", kind: "primary", blocks: toBlocks(cleaned, true) });
    }
    if (rest) sections.push(...build(rest));
  }
  sections.push(...build(tail));

  // Boilerplate belongs at the end regardless of where the firm put it, since
  // it is folded away as one group.
  const primary = sections.filter((s) => s.kind === "primary");
  const boiler = sections.filter((s) => s.kind === "boilerplate");

  return {
    sections: [...primary, ...boiler],
    structured: sections.some((s) => s.heading !== null),
    hasBoilerplate: boiler.length > 0,
    privacyNote,
  };
}
