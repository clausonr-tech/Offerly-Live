// How a Help assistant answer is tidied and laid out. Shared by the server
// (tidy before the language check and before returning) and the chat bubble
// (lay out as paragraphs and real lists), so both read the text the same way.
//
// The assistant is asked for plain text with "- " bullets. Models slip into
// markdown now and then, so tidyHelpReply strips what the bubble would show
// literally: headings, bold, code fences, table pipes.

export type HelpReplyBlock = { kind: "text"; text: string } | { kind: "list"; items: string[] };

const BULLET = /^\s*(?:[-*•‣▪]|\d{1,2}[.)])(?:\s+|$)/;

/** Plain text with "- " bullets, whatever markdown the model reached for. */
export function tidyHelpReply(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  text = text.replace(/^```[^\n]*\n?/gm, ""); // code fences
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // headings
  text = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1"); // bold
  text = text.replace(/(^|[\s(])\*(\S[^*\n]*?\S|\S)\*(?=[\s).,!?:;]|$)/gm, "$1$2"); // italics
  text = text.replace(/`([^`\n]+)`/g, "$1"); // inline code
  text = text.replace(/^\s*\|?\s*:?-{3,}.*$/gm, ""); // table rules
  text = text.replace(/^\s*[*•‣▪]\s+/gm, "- "); // other bullet marks become "- "
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * The answer as blocks: runs of bullet lines become one list, everything else
 * a paragraph. Numbered lines ("1. ...") count as bullets too; their order is
 * kept, and the bubble shows them as a list.
 */
export function parseHelpReply(text: string): HelpReplyBlock[] {
  const blocks: HelpReplyBlock[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      // A blank line ends a paragraph but not a list: "- a\n\n- b" is one list.
      const last = blocks[blocks.length - 1];
      if (last?.kind === "text" && last.text) blocks.push({ kind: "text", text: "" });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (BULLET.test(trimmed)) {
      const item = trimmed.replace(BULLET, "").trim();
      if (!item) continue;
      if (last?.kind === "list") last.items.push(item);
      else blocks.push({ kind: "list", items: [item] });
    } else if (last?.kind === "text" && last.text) {
      last.text = `${last.text} ${trimmed}`;
    } else if (last?.kind === "text") {
      last.text = trimmed;
    } else {
      blocks.push({ kind: "text", text: trimmed });
    }
  }
  return blocks.filter((b) => (b.kind === "text" ? b.text.length > 0 : b.items.length > 0));
}

/** Past this many words an answer is cut back to its lead line and first bullets. */
export const HELP_REPLY_TRIM_WORDS = 85;
const KEEP_BULLETS = 5;
const CLOSER_MAX_WORDS = 10;

/**
 * The backstop for an answer that ran long despite the prompt: keep the lead
 * line, the first five bullets and a short closing line; drop the extra
 * paragraphs. Answers within HELP_REPLY_TRIM_WORDS are returned untouched,
 * and so is one with no bullets to fall back on.
 */
export function trimHelpReply(text: string): string {
  if (helpReplyWordCount(text) <= HELP_REPLY_TRIM_WORDS) return text;
  const blocks = parseHelpReply(text);
  const firstList = blocks.findIndex((b) => b.kind === "list");
  if (firstList < 0) return text;

  const lead = blocks.slice(0, firstList).find((b): b is { kind: "text"; text: string } => b.kind === "text");
  const bullets = blocks.flatMap((b) => (b.kind === "list" ? b.items : [])).slice(0, KEEP_BULLETS);
  const tail = blocks[blocks.length - 1];
  const closer = tail.kind === "text" && helpReplyWordCount(tail.text) <= CLOSER_MAX_WORDS ? tail.text : "";

  return [lead?.text, bullets.map((b) => `- ${b}`).join("\n"), closer].filter(Boolean).join("\n");
}

/** Words in the answer, for the length checks. */
export function helpReplyWordCount(text: string): number {
  return text
    .replace(BULLET, "")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export type HelpInline = string | { label: string; href: string };

/**
 * `Open "Interview Prep" (/learn)` becomes a link on "Interview Prep".
 *
 * The prompt has the model name each page with its address, which keeps it
 * precise, but a bare "/learn" means nothing to a student. So the pair is
 * rendered as one clickable page name instead. Only in-app paths qualify - a
 * single leading slash and plain path characters - so a reply can never turn
 * into a link off the site ("//evil.com", "javascript:"), whatever it says.
 */
const PAGE_LINK = /["“]([^"”\n]{1,40})["”]\s*\((\/(?!\/)[A-Za-z0-9/_\-?=&.]*)\)/g;

export function helpInlineLinks(text: string): HelpInline[] {
  const out: HelpInline[] = [];
  let last = 0;
  for (const m of text.matchAll(PAGE_LINK)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ label: m[1].trim(), href: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
