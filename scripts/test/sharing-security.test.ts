// Links a student types are shown to recruiters and other students as
// something to click, so only real https LinkedIn addresses are stored and
// only http(s) is ever rendered as a link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkedinLink, profileLinksSchema } from "../../src/lib/validation";
import { safeHttpUrl } from "../../src/lib/safe-url";

const accepts = (v: string) => profileLinksSchema.safeParse({ linkedinUrl: v }).success;

test("onboarding stores only an https linkedin.com link", () => {
  assert.equal(accepts("https://www.linkedin.com/in/someone"), true);
  assert.equal(accepts("https://linkedin.com/in/someone"), true);
  assert.equal(accepts(""), true, "blank is allowed - it is optional");
  for (const bad of [
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://www.linkedin.com/in/someone",
    "https://linkedin.com.evil.example/in/someone",
    "https://evil.example/?linkedin.com",
    "vbscript:msgbox(1)",
  ]) {
    assert.equal(accepts(bad), false, bad);
  }
});

test("a stored link that is not http(s) is never rendered as one", () => {
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,x"), null);
  assert.equal(safeHttpUrl("https://www.linkedin.com/in/someone"), "https://www.linkedin.com/in/someone");
});

// A LinkedIn link is exempt from the blocked-language check because it carries
// no words. That is only true of what gets STORED: WHATWG `new URL()` strips
// tabs, newlines and carriage returns before parsing, so a multi-line value
// parses as a clean linkedin.com address while the newlines survive in the
// string - and that string is interpolated into the draft prompt's STUDENT
// block and into the signature of the email the student sends (INPUT-3 F2).
test("a LinkedIn link is stored as the parser read it, never as it was typed", () => {
  const stored = (v: string) => {
    const parsed = profileLinksSchema.safeParse({ linkedinUrl: v });
    return parsed.success ? parsed.data.linkedinUrl : null;
  };
  // What the exemption claims: nothing but a URL is ever stored.
  assert.equal(stored("https://www.linkedin.com/in/someone"), "https://www.linkedin.com/in/someone");
  assert.equal(stored("  https://www.linkedin.com/in/someone  "), "https://www.linkedin.com/in/someone");
  assert.equal(stored(""), "");

  // Whitespace inside the value is refused outright rather than parsed clean.
  for (const bad of [
    "https://www.linkedin.com/in/x\n\nSTUDENT\nYear: senior (graduates 2027)",
    "https://www.linkedin.com/in/x\r\nRECIPIENT\nName: someone else",
    "https://www.linkedin.com/in/x\tHOUSE RULES",
    "https://www.linkedin.com/in/x with a note",
  ]) {
    assert.equal(accepts(bad), false, JSON.stringify(bad));
    assert.equal(stored(bad), null, JSON.stringify(bad));
  }

  // And a link longer than the column's cap is refused, not truncated.
  assert.equal(accepts(`https://www.linkedin.com/in/${"a".repeat(600)}`), false);
});

test("the shared LinkedIn helper is what both entry points store", () => {
  assert.deepEqual(linkedinLink("https://www.linkedin.com/in/someone"), { href: "https://www.linkedin.com/in/someone" });
  assert.deepEqual(linkedinLink("   "), { href: null });
  // href, not the raw input: a trailing-slash-less path and an upper-case host
  // come back as the parser's own form.
  assert.deepEqual(linkedinLink("https://WWW.LinkedIn.com/in/someone"), { href: "https://www.linkedin.com/in/someone" });
  assert.equal("error" in linkedinLink("https://www.linkedin.com/in/x\nSTUDENT"), true);
  assert.equal("error" in linkedinLink("http://www.linkedin.com/in/x"), true);
  assert.equal("error" in linkedinLink("javascript:alert(1)"), true);
  assert.equal("error" in linkedinLink(`https://www.linkedin.com/in/${"a".repeat(600)}`), true);
});
