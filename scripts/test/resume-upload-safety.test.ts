// A resume is served back inline to recruiters and over a no-account share
// link, so the bytes must really be the kind of file the name claims and the
// serving routes must sandbox them. These two ends are checked together: the
// upload-time signature check (resumeBytesMatchExtension) and the response
// headers on every route that serves a stored resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { resumeBytesMatchExtension, saveResumeFile } from "@/lib/resume-storage";

const bytes = (...n: number[]) => new Uint8Array(n);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37); // "%PDF-1.7"
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const DOCX = bytes(0x50, 0x4b, 0x03, 0x04); // zip
const DOC = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1); // OLE
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
const HTML = new TextEncoder().encode("<html><script>alert(document.cookie)</script></html>");

test("a real file of each type is accepted by its extension", () => {
  assert.ok(resumeBytesMatchExtension("r.pdf", PDF));
  assert.ok(resumeBytesMatchExtension("r.png", PNG));
  assert.ok(resumeBytesMatchExtension("r.jpg", JPEG));
  assert.ok(resumeBytesMatchExtension("r.jpeg", JPEG));
  assert.ok(resumeBytesMatchExtension("r.docx", DOCX));
  assert.ok(resumeBytesMatchExtension("r.doc", DOC));
  assert.ok(resumeBytesMatchExtension("r.webp", WEBP));
});

test("plain-text resumes are allowed without a signature (and are safe to serve as text/plain)", () => {
  assert.ok(resumeBytesMatchExtension("r.txt", new TextEncoder().encode("Jane Doe\nExperience\n")));
  assert.ok(resumeBytesMatchExtension("r.txt", new Uint8Array(0)));
});

test("a file whose bytes do not match its name is rejected", () => {
  assert.ok(!resumeBytesMatchExtension("evil.pdf", HTML));
  assert.ok(!resumeBytesMatchExtension("evil.png", HTML));
  assert.ok(!resumeBytesMatchExtension("evil.docx", HTML));
  assert.ok(!resumeBytesMatchExtension("shell.jpg", PDF), "a PDF renamed .jpg is not a JPEG");
  assert.ok(!resumeBytesMatchExtension("r.webp", bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20)), "RIFF that is not WEBP");
});

test("a PDF with a leading BOM is still recognised", () => {
  assert.ok(resumeBytesMatchExtension("r.pdf", new Uint8Array([0xef, 0xbb, 0xbf, ...PDF])));
});

test("saveResumeFile refuses a disguised upload before storing anything", async () => {
  // HTML wearing a .pdf name: the extension allow-list passes, so only the
  // signature check stands between it and being served back inline. This
  // rejects before putStoredFile, so it needs no database.
  const file = new File([HTML], "resume.pdf", { type: "application/pdf" });
  await assert.rejects(saveResumeFile(file), /does not look like/);
});

// The firm portal's resume route went with the firm portal in this build, so
// there is no third serving route left to check. The two below still serve
// stored files and still have to sandbox them.
const SERVING_ROUTES = [
  "src/app/r/[token]/route.ts",
  "src/app/api/resume/current/route.ts",
];

for (const rel of SERVING_ROUTES) {
  test(`${rel} sandboxes the file and sends nosniff`, () => {
    const src = readFileSync(path.join(process.cwd(), rel), "utf8");
    assert.match(src, /"Content-Security-Policy":\s*"sandbox;/, "missing sandbox CSP");
    assert.match(src, /"X-Content-Type-Options":\s*"nosniff"/, "missing nosniff");
  });
}
