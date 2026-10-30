/**
 * The .docx reader stays fast and small on hostile input.
 *
 * A student can upload a .docx resume, and lib/docx-text reads it on the
 * request thread, synchronously, before any AI quota is spent - so a crafted
 * archive's cost is the server's cost. The three shapes that used to be free
 * for an attacker and expensive for us:
 *
 *   - a long run of "<" with no ">", which made /<[^>]+>/g rescan to the end
 *     of the string from every one of those positions (quadratic);
 *   - a long run of spaces with no newline, same shape for /[ \t]+\n/g;
 *   - a central directory naming the same part hundreds of times, each one
 *     inflated and held in memory until the final slice.
 *
 * Each is built here as a real zip (stored, not deflated, so the test needs
 * no compression) and read with a wall clock around it. The numbers are
 * deliberately loose - this is a check that the work is linear and bounded,
 * not a benchmark - but a quadratic reader misses them by orders of
 * magnitude: 200KB of "<" took tens of seconds before.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { docxToText } from "@/lib/docx-text";

/** A zip holding the given parts, every one stored uncompressed. */
function zip(parts: { name: string; body: string }[], extraDirectoryCopies = 0): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, "utf8");
    const data = Buffer.from(part.body, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    // A zip may name the same local header as often as it likes, which is the
    // cheap way to ask for one part to be inflated hundreds of times.
    for (let i = 0; i <= extraDirectoryCopies; i++) central.push(entry);
    offset += local.length + data.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, eocd]);
}

function msToRead(buf: Buffer): { ms: number; text: string } {
  const started = process.hrtime.bigint();
  let text = "";
  try {
    text = docxToText(buf);
  } catch {
    /* a refusal is a fine outcome; the point is that it is fast */
  }
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, text };
}

const BUDGET_MS = 2_000;

test("an ordinary .docx still reads, headers first", () => {
  const buf = zip([
    { name: "word/header1.xml", body: "<w:p><w:t>Jane Doe</w:t></w:p>" },
    { name: "word/document.xml", body: "<w:p><w:t>Analyst</w:t><w:tab/><w:t>2026</w:t></w:p><w:p><w:t>Rowed  hard</w:t></w:p>" },
  ]);
  assert.equal(docxToText(buf), "Jane Doe\n\nAnalyst\t2026\nRowed  hard");
});

test("entities are decoded, and one that names no character is left alone", () => {
  const buf = zip([
    { name: "word/document.xml", body: "<w:t>M&amp;A &#x2014; 40&#37; &lt;top&gt; &#xffffff; &#99999999;</w:t>" },
  ]);
  assert.equal(docxToText(buf), "M&A — 40% <top> &#xffffff; &#99999999;");
});

test("a run of < with no > does not make the reader rescan it", () => {
  const { ms } = msToRead(zip([{ name: "word/document.xml", body: "<".repeat(400_000) }]));
  assert.ok(ms < BUDGET_MS, `400,000 unterminated tags took ${ms.toFixed(0)}ms`);
});

test("a run of spaces with no newline does not either", () => {
  const body = `<w:t>Jane</w:t>${" ".repeat(400_000)}`;
  const { ms, text } = msToRead(zip([{ name: "word/document.xml", body }]));
  assert.ok(ms < BUDGET_MS, `400,000 trailing spaces took ${ms.toFixed(0)}ms`);
  assert.equal(text, "Jane");
});

test("the work grows with the input, not with its square", () => {
  const run = (n: number) => msToRead(zip([{ name: "word/document.xml", body: "<".repeat(n) }])).ms;
  run(50_000); // warm up, so the first JIT pass is not counted as growth
  const small = Math.max(1, run(100_000));
  const large = Math.max(1, run(800_000));
  // Eight times the input. Linear work lands near 8x; the quadratic version
  // would be about 64x.
  assert.ok(large / small < 24, `8x the input took ${(large / small).toFixed(1)}x the time`);
});

test("a directory naming one part hundreds of times reads it a handful of times at most", () => {
  // 300 copies of a 20KB header: unbounded, that is 6MB of strings held at
  // once for a 20KB file. De-duplicated and capped, it is one part.
  const header = `<w:t>${"Jane Doe ".repeat(2_000)}</w:t>`;
  const buf = zip([{ name: "word/header1.xml", body: header }, { name: "word/document.xml", body: "<w:t>Analyst</w:t>" }], 300);
  const { ms, text } = msToRead(buf);
  assert.ok(ms < BUDGET_MS, `300 copies of one header took ${ms.toFixed(0)}ms`);
  assert.ok(text.endsWith("Analyst"), "the body is still read");
  assert.ok(text.length <= 100_000, "and the text that comes out is capped");
  // The header's words appear once, not 300 times.
  assert.ok(text.length < 25_000, `the header was read ${Math.round(text.length / 18_000)} times`);
});

test("more text than the cap comes back cut to the cap", () => {
  const buf = zip([{ name: "word/document.xml", body: `<w:t>${"word ".repeat(60_000)}</w:t>` }]);
  const length = docxToText(buf).length;
  // 100,000 characters of text, less the space the cap landed on.
  assert.ok(length > 99_900 && length <= 100_000, `got ${length} characters`);
});

test("an archive larger than an upload may be is refused outright", () => {
  const buf = Buffer.concat([zip([{ name: "word/document.xml", body: "<w:t>Jane</w:t>" }]), Buffer.alloc(5 * 1024 * 1024)]);
  assert.throws(() => docxToText(buf), /under 4MB/);
});

test("a file that is not a .docx is still refused the same way", () => {
  assert.throws(() => docxToText(Buffer.from("not a zip at all")), /Not a \.docx/);
  assert.throws(() => docxToText(zip([{ name: "word/header1.xml", body: "<w:t>x</w:t>" }])), /Not a \.docx/);
});
