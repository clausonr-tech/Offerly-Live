import "server-only";
import { inflateRawSync } from "node:zlib";

// Plain text out of a .docx, with no dependency.
//
// The model reads PDFs, images and plain text, but not Word files. A .docx is
// a zip archive of XML, so this reads the zip's directory, inflates the body
// and header parts with Node's own zlib, and strips the markup - enough to
// hand the model the resume's words. Layout is lost, which is fine: the reader
// only needs what the resume says. Legacy binary .doc is a different format
// entirely and isn't handled.
//
// Every step here is bounded, because the input is an upload and this runs on
// the request thread before any quota is spent. A 4MB zip may name 65,535
// parts, point them all at one highly compressed local header, and fill them
// with whatever bytes it likes - so the archive, each part, the sum of all
// parts, the number of parts and the text that comes out all have a ceiling.
// The markup is stripped by one left-to-right walk rather than by regexes,
// which is the other half of the same problem: /<[^>]+>/g over a long run of
// "<" with no ">" rescans to the end of the string from every one of those
// positions. That is quadratic - tens of seconds for a few hundred KB of
// hostile input - and a plain CPU loop, so the try/catch around the caller
// cannot interrupt it.

/**
 * The archive itself. The upload paths already refuse a resume over
 * MAX_FILE_BYTES (4MB, lib/file-store), but this reader is also handed bytes
 * from storage, so it states its own ceiling rather than trusting the caller's.
 */
const MAX_DOCX_BYTES = 4 * 1024 * 1024;
// Per part, after decompression. A resume's XML is well under this; the cap is
// what stops a small, highly compressed file from expanding to fill memory.
const MAX_PART_BYTES = 5 * 1024 * 1024;
/**
 * Across every part this reads, together. A per-part cap alone bounds nothing
 * when the directory may name hundreds of parts that all inflate to the limit.
 */
const MAX_TOTAL_PART_BYTES = 8 * 1024 * 1024;
/** Header parts read, after de-duplicating names. A real .docx has three. */
const MAX_HEADER_PARTS = 8;
const MAX_TEXT_CHARS = 100_000;

type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number };

function listEntries(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits in the last 22 bytes, or up to
  // 64KB earlier when the archive has a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a .docx file.");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      // From the central directory, which is reliable even when the local
      // header defers sizes to a trailing data descriptor.
      compressedSize: buf.readUInt32LE(p + 20),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.toString("utf8", p + 46, p + 46 + nameLength),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One part's bytes as text, never more than `maxBytes` of them. */
function readEntry(buf: Buffer, entry: ZipEntry, maxBytes: number): string {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new Error("That .docx file is damaged.");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.subarray(0, maxBytes).toString("utf8");
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes }).toString("utf8");
  throw new Error("That .docx file uses an unsupported compression.");
}

/** A numeric character reference, when it names a character that exists. */
function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/**
 * The named and numeric entities Word writes, decoded.
 *
 * Every quantifier is bounded: "&#x" followed by a long run of hex digits and
 * no ";" is the same quadratic shape as an unterminated tag, and an unbounded
 * run also parses to a number no character has, which String.fromCodePoint
 * throws on. Six hex digits and seven decimal ones cover every code point.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (whole, hex: string) => codePoint(parseInt(hex, 16)) || whole)
    .replace(/&#(\d{1,7});/g, (whole, dec: string) => codePoint(Number(dec)) || whole)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Spaces before a line break dropped and runs of blank lines collapsed, in
 * one pass.
 *
 * The regex forms of these two rules (/[ \t]+\n/g and /\n{3,}/g) backtrack
 * over every space in a long run that no newline follows, so they are the
 * same quadratic trap as the tag strip. A pass that remembers only how much
 * whitespace it is holding is linear and says the same thing.
 */
function collapseWhitespace(text: string): string {
  const out: string[] = [];
  // Where the run of spaces and tabs being held began, or -1 for none. The
  // run is kept as a slice rather than a count so a tab stays a tab.
  let held = -1;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      if (held < 0) held = i;
      continue;
    }
    if (ch === "\n") {
      // Whatever was being held sat at the end of a line, so it is dropped.
      newlines++;
      held = -1;
      continue;
    }
    if (newlines > 0) {
      // Three or more blank lines read as a section break, not as spacing.
      out.push(newlines >= 3 ? "\n\n" : "\n".repeat(newlines));
      newlines = 0;
    }
    // A held run is only ever from after the last line break, so this keeps a
    // line's own indentation and drops only what trailed off the end.
    if (held >= 0 && out.length > 0) out.push(text.slice(held, i));
    held = -1;
    out.push(ch);
  }
  return out.join("");
}

/**
 * The words in one part's XML: tags removed, the few that mean "new line" or
 * "tab" turned into one, and never more than `limit` characters of text.
 *
 * One left-to-right walk. Each search for the ">" that closes a tag starts
 * where the last one ended, so the whole scan costs the length of the string
 * once however the markup is shaped; and the first "<" with no ">" after it
 * ends the walk, because nothing past it can be a tag.
 */
function xmlToText(xml: string, limit: number): string {
  const out: string[] = [];
  let kept = 0;
  let i = 0;
  while (i < xml.length && kept < limit) {
    const open = xml.indexOf("<", i);
    if (open < 0) {
      const text = xml.slice(i, i + (limit - kept));
      out.push(text);
      kept += text.length;
      break;
    }
    if (open > i) {
      const text = xml.slice(i, Math.min(open, i + (limit - kept)));
      out.push(text);
      kept += text.length;
    }
    const close = xml.indexOf(">", open + 1);
    // An unterminated "<" is the end of anything this can read as markup.
    if (close < 0) break;
    const tag = xml.slice(open + 1, close);
    // Counted against the limit like any other character: a part that is
    // nothing but a million paragraph ends must cost no more than one that is
    // a million words.
    const whitespace = /^w:tab\b/.test(tag) && tag.endsWith("/")
      ? "\t"
      : (/^w:(br|cr)\b/.test(tag) && tag.endsWith("/")) || tag === "/w:p"
        ? "\n"
        : "";
    if (whitespace) {
      out.push(whitespace);
      kept++;
    }
    i = close + 1;
  }
  return collapseWhitespace(decodeEntities(out.join(""))).trim();
}

/** The words in a .docx: headers first (where a resume's name often lives), then the body. */
export function docxToText(buf: Buffer): string {
  if (buf.length > MAX_DOCX_BYTES) throw new Error("Resume must be under 4MB.");
  const entries = listEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  // De-duplicated and capped: a directory may name the same header part
  // hundreds of times, and every name read means another part inflated.
  const headers = [...new Set(entries.map((e) => e.name).filter((name) => /^word\/header\d*\.xml$/.test(name)))]
    .sort()
    .slice(0, MAX_HEADER_PARTS);
  const body = byName.get("word/document.xml");
  if (!body) throw new Error("Not a .docx file.");

  const parts: string[] = [];
  let bytesLeft = MAX_TOTAL_PART_BYTES;
  let charsLeft = MAX_TEXT_CHARS;
  for (const entry of [...headers.map((name) => byName.get(name)!), body]) {
    if (bytesLeft <= 0 || charsLeft <= 0) break;
    const raw = readEntry(buf, entry, Math.min(MAX_PART_BYTES, bytesLeft));
    bytesLeft -= raw.length;
    const text = xmlToText(raw, charsLeft);
    if (!text) continue;
    parts.push(text);
    charsLeft -= text.length;
  }

  return parts.join("\n\n").slice(0, MAX_TEXT_CHARS);
}
