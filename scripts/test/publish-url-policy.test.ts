/**
 * A crawled URL cannot be published, and cannot become an href.
 *
 * The crawler copies a listing's address out of content nobody here controls -
 * the generic connector takes a JSON-LD `url` or a keyword-matching anchor
 * href verbatim - and nothing between that and the student's screen checked
 * the scheme or the host. An auto-approved listing was promoted by the hourly
 * script, written to internship_postings and rendered straight into
 * `href={p.sourceUrl}`; a listing the classifier rejected as a campus event
 * became a firm_recruiting_events row with no review state at all, rendered
 * into `href={event.eventUrl}` on the firm's page and copied into the
 * student's calendar notes. React 19 rewrites `javascript:` and nothing else,
 * so `data:`, `vbscript:` and a scheme-less value (a link back into the app)
 * all survived to the DOM (security review, 10 October 2026).
 *
 * Both boundaries are asserted here, because each one alone is bypassable:
 *
 *   WRITE  - classifyListing refuses to auto-approve such a listing,
 *            savePosting refuses to store one, the events feed drops one.
 *   READ   - every student-facing component that emits one of these stored
 *            strings as an href routes it through lib/safe-url. Asserted at
 *            the SOURCE, the way firm-portal-privacy.test.ts asserts what the
 *            Analytics page prints, because the hole was in what the
 *            component rendered rather than in what the lib returned.
 *
 * In-memory PGlite, no network, no DATABASE_URL.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { firmRecruitingEvents, firms, internshipPostings } from "@/db/schema";
import { classifyListing, hasPublishableUrls } from "@/lib/monitoring/classify";
import { deriveApplyUrl, preferApplyUrl } from "@/lib/monitoring/apply-url";
import { normalizeBoardUrl } from "@/lib/monitoring/board-url";
import { savePosting } from "@/lib/internship-postings";
import { listFirmRecruitingEvents } from "@/lib/recruiting-events-feed";
import { externalHref, publicHttpUrl, safeHttpUrl, safeLinkUrl } from "@/lib/safe-url";
import {
  applicationSchema,
  contactSchema,
  isLinkedinUrl,
  isPublicWebUrl,
} from "@/lib/validation";
import type { NormalizedListing } from "@/lib/monitoring/connectors/types";

delete process.env.DATABASE_URL;

/**
 * The values a defaced or hostile careers page can put where a URL goes.
 *
 * `\u0001javascript:` is here because the static scan's own denylist runs on a
 * `.trim()`ed string and JS trim does not remove C0 control characters, while
 * WHATWG URL parsing does - so the control character slips past a textual
 * denylist and normalises back to `javascript:`. Anything that judges the
 * PARSED url, as lib/safe-url does, is unaffected, and that is the point of
 * asserting it.
 */
const HOSTILE = [
  "javascript:alert(1)",
  "\u0001javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "careers.example.com/apply", // no scheme at all - a link back into the app
  "//evil.example/apply", // protocol-relative
  "http://127.0.0.1:9200/_search", // loopback
  "http://169.254.169.254/latest/meta-data/", // cloud metadata
  "http://localhost/admin",
  "http://jenkins.internal/job/deploy",
  "http://example.com:6379/", // not a web port
  "https://greenhouse.io@attacker.example/x", // credentials disguising the host
];

/** Links a real board legitimately uses, which must all keep working. */
const LEGITIMATE = [
  "https://jobs.lever.co/acme/1234-5678",
  "https://boards.greenhouse.io/acme/jobs/4001",
  "https://acme.wd1.myworkdayjobs.com/en-US/External/job/New-York/Summer-Analyst_R1",
  "https://careers.example.com/2027-summer-analyst",
  "http://careers.example.com/2027-summer-analyst",
  "https://apply.workable.com/acme/j/ABC123/",
  "https://acme.tal.net/candidate/jobboard/vacancy/2/adv/",
];

describe("the URL policy itself", () => {
  test("every hostile value is refused", () => {
    for (const raw of HOSTILE) {
      assert.equal(publicHttpUrl(raw), null, `publicHttpUrl accepted ${JSON.stringify(raw)}`);
    }
  });

  test("every legitimate board link survives", () => {
    for (const raw of LEGITIMATE) {
      assert.ok(publicHttpUrl(raw), `publicHttpUrl turned away ${raw}`);
    }
  });

  test("safeHttpUrl - the read boundary - refuses the same schemes and scheme-less values", () => {
    for (const raw of ["javascript:alert(1)", "\u0001javascript:alert(1)", "data:text/html,x", "vbscript:msgbox(1)", "careers.example.com/apply", "//evil.example/x"]) {
      assert.equal(safeHttpUrl(raw), null, `safeHttpUrl accepted ${JSON.stringify(raw)}`);
      assert.equal(safeLinkUrl(raw), undefined, `safeLinkUrl accepted ${JSON.stringify(raw)}`);
    }
    // One of our own routes still has to work - that is why safeLinkUrl exists.
    assert.equal(safeLinkUrl("/api/firm-events/abc/open"), "/api/firm-events/abc/open");
  });
});

describe("the write boundary: a hostile URL never reaches auto-approval", () => {
  /**
   * A listing that is otherwise a textbook auto-approval.
   *
   * `applicationUrl` defaults to the listing URL because that is what the
   * pipeline stores (monitor-run calls preferApplyUrl, whose floor is the
   * listing URL) and because posting-quality's `verifiable` - which
   * auto-approval requires - needs a non-null one.
   */
  const listing = (listingUrl: string, applicationUrl: string | null = listingUrl): NormalizedListing => ({
    externalJobId: "REQ-1",
    title: "2027 Investment Banking Summer Analyst (New York)",
    division: "Investment Banking",
    location: "New York, NY",
    descriptionRaw:
      "Our 2027 Investment Banking Summer Analyst Program in New York runs for ten weeks. " +
      "Summer Analysts join a deal team and support live M&A and capital markets transactions, " +
      "building financial models, preparing client materials and conducting industry research. " +
      "Applicants should be undergraduates graduating in the Class of 2028 with a strong academic " +
      "record and demonstrated interest in financial services. Requirements: pursuing a Bachelor's " +
      "degree, graduating in 2028, excellent written and verbal communication skills, and proficiency " +
      "in Excel and PowerPoint. Applications are reviewed on a rolling basis.",
    employmentType: "Internship",
    applicationUrl,
    listingUrl,
    publishedAt: null,
  });

  test("the control: a clean listing IS auto-approved", () => {
    const c = classifyListing(listing("https://careers.example.com/2027-summer-analyst"), "investment_banking");
    assert.equal(c.relevant, true, `expected relevant; evidence: ${c.matchedEvidence.join(" | ")}`);
    assert.equal(c.needsHumanReview, false, `expected auto-approval; reason: ${c.reasonForUncertainty}`);
  });

  test("the same listing on a hostile URL is held for a human instead", () => {
    for (const raw of HOSTILE) {
      const c = classifyListing(listing(raw), "investment_banking");
      assert.equal(c.needsHumanReview, true, `auto-approved a listing whose listingUrl is ${JSON.stringify(raw)}`);
    }
  });

  test("a hostile APPLICATION url holds it too, even with a clean listing url", () => {
    for (const raw of HOSTILE) {
      const c = classifyListing(listing("https://careers.example.com/x", raw), "investment_banking");
      assert.equal(c.needsHumanReview, true, `auto-approved a listing whose applicationUrl is ${JSON.stringify(raw)}`);
    }
  });

  test("hasPublishableUrls is the same question the promote step asks", () => {
    assert.equal(hasPublishableUrls({ listingUrl: "https://careers.example.com/x" }), true);
    // A null application url is normal, not a failure.
    assert.equal(hasPublishableUrls({ listingUrl: "https://careers.example.com/x", applicationUrl: null }), true);
    for (const raw of HOSTILE) {
      assert.equal(hasPublishableUrls({ listingUrl: raw }), false, `accepted listingUrl ${JSON.stringify(raw)}`);
      assert.equal(
        hasPublishableUrls({ listingUrl: "https://careers.example.com/x", applicationUrl: raw }),
        false,
        `accepted applicationUrl ${JSON.stringify(raw)}`,
      );
    }
  });

  test("preferApplyUrl never promotes a hostile stated url over the advert", () => {
    for (const raw of HOSTILE) {
      const out = preferApplyUrl({ applicationUrl: raw, listingUrl: "https://jobs.lever.co/acme/1234" });
      assert.notEqual(out, raw, `stored ${JSON.stringify(raw)} as the apply url`);
      assert.ok(out.startsWith("https://jobs.lever.co/acme/1234"), `unexpected fallback: ${out}`);
    }
    // Behaviour preserved: a real stated url still wins, and a derived one is
    // still derived when the connector has nothing better.
    assert.equal(
      preferApplyUrl({ applicationUrl: "https://apply.example.com/form", listingUrl: "https://careers.example.com/x" }),
      "https://apply.example.com/form",
    );
    assert.equal(
      preferApplyUrl({ applicationUrl: "https://jobs.lever.co/acme/1234", listingUrl: "https://jobs.lever.co/acme/1234" }),
      "https://jobs.lever.co/acme/1234/apply",
    );
  });

  test("deriveApplyUrl builds nothing on a hostile origin", () => {
    for (const raw of HOSTILE) assert.equal(deriveApplyUrl(raw), null, `derived from ${JSON.stringify(raw)}`);
  });

  test("a discovered board URL is refused unless it is a public http(s) one", () => {
    for (const raw of HOSTILE) {
      const out = normalizeBoardUrl(raw);
      assert.equal(out.ok, false, `registered ${JSON.stringify(raw)} as a board`);
    }
    // Behaviour preserved.
    assert.equal(normalizeBoardUrl("https://jobs.lever.co/acme/engineer").ok, true);
    assert.equal(normalizeBoardUrl("http://careers.example.com/students").ok, true);
  });
});

describe("the write boundary: savePosting and the events feed", () => {
  let h: TestDatabase;
  let restore: () => void;

  before(async () => {
    h = await createTestDb();
    restore = installAsAppDb(h.db);
  });
  after(async () => {
    restore();
    await h.close();
  });

  let seq = 0;
  const mkFirm = async () => {
    const [f] = await h.db
      .insert(firms)
      .values({
        slug: `publish-url-${++seq}-${Date.now()}`,
        name: `Firm ${seq}`,
        headquarters: "New York",
        keyOffices: "New York",
        website: "example.com",
        description: "A test firm.",
      })
      .returning();
    return f;
  };

  const posting = (sourceUrl: string, applicationUrl: string | null = null) => ({
    roleTitle: "2027 Summer Analyst",
    location: "New York, NY",
    programYear: 2027,
    eligibleGradYears: [2028],
    deadlineStatus: "tbd" as const,
    deadlineText: null,
    deadlineDateIso: null,
    descriptionFull: "Ten weeks on a deal team.",
    sourceUrl,
    applicationUrl,
    recruiterName: null,
    recruiterTitle: null,
    recruiterEmail: null,
    recruiterPhone: null,
  });

  test("savePosting stores a clean posting", async () => {
    const firm = await mkFirm();
    const outcome = await savePosting(firm.id, ["investment_banking"], posting("https://careers.example.com/sa"));
    assert.equal(outcome, "inserted");
  });

  test("savePosting refuses a posting whose source URL is hostile, and stores nothing", async () => {
    for (const raw of HOSTILE) {
      const firm = await mkFirm();
      const outcome = await savePosting(firm.id, ["investment_banking"], posting(raw));
      assert.equal(outcome, "skipped", `stored a posting with sourceUrl ${JSON.stringify(raw)}`);
      const rows = await h.db.select().from(internshipPostings);
      assert.equal(
        rows.some((r) => r.firmId === firm.id),
        false,
        `a row was written for ${JSON.stringify(raw)}`,
      );
    }
  });

  test("savePosting drops a hostile application URL but keeps the reachable advert", async () => {
    const firm = await mkFirm();
    const outcome = await savePosting(
      firm.id,
      ["investment_banking"],
      posting("https://careers.example.com/sa", "javascript:alert(1)"),
    );
    assert.equal(outcome, "inserted");
    const row = (await h.db.select().from(internshipPostings)).find((r) => r.firmId === firm.id);
    assert.ok(row);
    assert.equal(row.applicationUrl, null);
    assert.equal(row.sourceUrl, "https://careers.example.com/sa");
  });

  test("a crawled event with a hostile link never reaches a student", async () => {
    const firm = await mkFirm();
    const soon = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await h.db.insert(firmRecruitingEvents).values([
      { firmId: firm.id, title: "Real info session", eventDate: soon, eventUrl: "https://careers.example.com/rsvp" },
      ...HOSTILE.map((raw, i) => ({
        firmId: firm.id,
        title: `Hostile ${i}`,
        eventDate: soon,
        eventUrl: raw,
      })),
    ]);

    const shown = await listFirmRecruitingEvents(firm.id, new Date(), undefined, "America/New_York");
    assert.deepEqual(
      shown.map((e) => e.title),
      ["Real info session"],
      `a hostile event link was returned: ${JSON.stringify(shown.map((e) => e.eventUrl))}`,
    );
    for (const e of shown) assert.ok(publicHttpUrl(e.eventUrl), `emitted ${e.eventUrl}`);
  });

  test("a firm-posted event keeps its internal route", async () => {
    const firm = await mkFirm();
    const soon = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const [row] = await h.db
      .insert(firmRecruitingEvents)
      .values({ firmId: firm.id, title: "Firm RSVP", eventDate: soon, eventUrl: "rsvp-marker", origin: "firm" })
      .returning();
    const shown = await listFirmRecruitingEvents(firm.id, new Date(), undefined, "America/New_York");
    assert.deepEqual(
      shown.map((e) => e.eventUrl),
      [`/api/firm-events/${row.id}/open`],
    );
  });
});

describe("the read boundary: no component emits a stored URL as a raw href", () => {
  /**
   * A DENY sweep, not an allowlist.
   *
   * This used to be thirteen hand-written `<file, expression>` pairs, which
   * asserted only what somebody had remembered to add. The adversarial review
   * of this branch found three render sites it had never heard of - the
   * contacts grid, the company page and the application detail page - and no
   * list of thirteen can fail on a fourteenth. So the shape is inverted: every
   * `.tsx` under src/app and src/components is read, every `href={...}` in it
   * is extracted, and each one must be PROVABLY one of a few safe forms. A new
   * `href={row.someStoredUrl}` fails this test the moment it is written,
   * without anybody adding an entry.
   *
   * What counts as proof, and nothing else does:
   *
   *   - a string or template literal that starts with `/`, `#`, `mailto:` or
   *     `tel:` - our own route, an anchor, or a scheme that cannot run code;
   *   - a call to one of the lib/safe-url guards;
   *   - `undefined` / `null` - an <a> with no href, which is the intended
   *     fallback when a guard returns nothing;
   *   - `??`, `||` and `? :` whose every branch is itself provable;
   *   - a value whose NAME is `href` (`item.href`, `backHref`, `HREF[...]`,
   *     `topicHref(t)`). See the naming convention below.
   *   - a bare local `const` in the same file bound to something provable.
   *
   * THE NAMING CONVENTION, and its limit. In this codebase `href` is the name
   * for a route our own code built - a nav item, a notification target, a tab.
   * A URL that came from outside is never called `href`; it is `linkedinUrl`,
   * `sourceUrl`, `applyUrl`, `careersUrl`, `link` or `url`. That is what makes
   * the `*href` accept safe, and it is a convention rather than a proof, so
   * the test below pins the only stored columns actually named `href` - all
   * three written solely by our own notification generators. A fourth one
   * fails that test and forces this accept to be re-argued.
   */
  const SWEEP_ROOTS = ["src/app", "src/components"];

  /** The lib/safe-url entry points. A call to any of them is proof enough. */
  const GUARDS = [
    "externalHref",
    "safeLinkUrl",
    "safeHttpUrl",
    "publicHttpUrl",
    "normaliseHttpUrl",
    "inAppPath",
  ];

  /**
   * Render sites that are NOT guarded and are not mine to fix in this pass.
   *
   * This is debt, not an allowlist: the sweep's default is to FAIL, nothing
   * reaches this list by accident, and each entry says why it is here. The
   * test asserts every entry still matches a real site, so a fixed site has to
   * be removed and the list can only shrink.
   */
  const KNOWN_UNGUARDED: [file: string, expr: string, reason: string][] = [
    // -- self-authored in this repo or by this request; no stored value at all.
    // (The marketing site's who-we-are page was one of these; it is not in this
    // build, so its entry is gone rather than excused.)
    ["src/app/(app)/news/NewsSourcesPicker.tsx", "librarySearch", "a google.com search URL this file builds"],
    ["src/app/(app)/learn/video/InterviewReport.tsx", "video.url", "the student's own uploaded answer, from our own storage"],
  ];

  /**
   * Every site this branch guarded. None may return to the debt list.
   *
   * The first four were the adversarial review's own findings. The sixteen
   * below them were the debt the sweep surfaced when it replaced the
   * hand-written allowlist, and they are the whole of it bar three
   * self-authored values: the crawled careers and listing URLs, the sourcing
   * provider's profile and source URLs, the news pipeline's article and
   * citation links, the LinkedIn field a student types, and the three Google
   * Calendar values (a real meet.google.com or calendar.google.com URL passes
   * `externalHref` unchanged - checked against the API's `hangoutLink`,
   * `htmlLink` and buildGoogleCalendarUrl's own output before wrapping them).
   */
  const FIXED_IN_THIS_PASS: [string, string][] = [
    ["src/app/(app)/contacts/ContactGrid.tsx", "row.linkedinUrl"],
    ["src/app/(app)/contacts/company/[key]/page.tsx", "p.linkedinUrl"],
    ["src/app/(app)/applications/[id]/page.tsx", "application.applicationUrl"],
    ["src/app/(app)/networking/clubs/[slug]/page.tsx", "club.websiteUrl"],
    // -- stored third-party or crawled URLs.
    ["src/app/(app)/discovery/ExpectedPostings.tsx", "role.careersUrl"],
    ["src/app/(app)/discovery/firm/[slug]/FirmProgramTabs.tsx", "program.careersUrl"],
    ["src/app/(app)/discovery/firm/[slug]/FirmProgramTabs.tsx", "program.recruitingChannelUrl"],
    ["src/app/(app)/discovery/firm/[slug]/GenerateContactsButton.tsx", "contact.linkedinUrl"],
    ["src/app/(app)/contacts/[id]/page.tsx", "contact.sourceUrl"],
    // The admin monitoring page was guarded in that pass too, but the admin
    // section is not in this build, so there is no file left to re-check.
    ["src/app/(app)/_home/NewsPanel.tsx", "item.link"],
    ["src/app/(app)/news/page.tsx", "src.link"],
    ["src/app/(app)/news/StoryPanel.tsx", "story.link"],
    ["src/app/(app)/news/MarketsDashboard.tsx", "s.link"],
    // -- student-supplied, shown back to that student or to a firm.
    ["src/app/(app)/profile/ResumeSection.tsx", "linkedinUrl"],
    ["src/app/(app)/drafts/GenerateForm.tsx", "selected?.linkedinUrl"],
    // The firm portal's student list was guarded in that pass as well; the
    // portal is not in this build, so the file it names is gone.
    // -- third-party API responses that are not stored by us.
    ["src/app/(app)/schedule/EventRow.tsx", "event.googleMeetUrl"],
    ["src/app/(app)/schedule/EventRow.tsx", "event.googleCalendarUrl"],
    ["src/app/(app)/schedule/CalendarView.tsx", "selected.google.htmlLink"],
  ];

  // ---------------------------------------------------------------- scanning

  const tsxFiles = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".tsx")) out.push(full);
      }
    };
    walk(path.join(process.cwd(), root));
    return out;
  };

  /**
   * Past a quoted or template string, honouring escapes and `${...}` nesting.
   *
   * A `}` inside a string is not the end of a JSX attribute, and a template
   * literal's own braces have to be walked rather than counted - which is why
   * this and `readBraced` call each other.
   */
  function skipString(src: string, i: number): number {
    const q = src[i];
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (q === "`" && c === "$" && src[i + 1] === "{") {
        const r = readBraced(src, i + 1);
        if (!r) return src.length;
        i = r.end + 1;
        continue;
      }
      if (c === q) return i + 1;
      i++;
    }
    return i;
  }

  /** The text inside the `{...}` that starts at `start`, brace-balanced. */
  function readBraced(src: string, start: number): { expr: string; end: number } | null {
    let depth = 0;
    let i = start;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skipString(src, i);
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        i = nl < 0 ? src.length : nl;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const e = src.indexOf("*/", i);
        i = e < 0 ? src.length : e + 2;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return { expr: src.slice(start + 1, i), end: i };
      }
      i++;
    }
    return null;
  }

  /** Every `href={...}` in a file, with the line it sits on. */
  const hrefExpressions = (src: string): { expr: string; line: number }[] => {
    const out: { expr: string; line: number }[] = [];
    const re = /href\s*=\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1;
      const r = readBraced(src, open);
      if (!r) continue;
      out.push({ expr: r.expr, line: src.slice(0, m.index).split("\n").length });
      re.lastIndex = r.end;
    }
    return out;
  };

  // ------------------------------------------------------------ classifying

  /** The index of `needle` at paren/brace/bracket depth 0, or -1. */
  const topLevelIndex = (expr: string, test: (s: string, i: number) => number): number => {
    let depth = 0;
    let i = 0;
    while (i < expr.length) {
      const c = expr[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skipString(expr, i);
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0) {
        const taken = test(expr, i);
        if (taken > 0) return i;
      }
      i++;
    }
    return -1;
  };

  /** Whether `expr` is a single bracketed group spanning the whole string. */
  const spansWhole = (expr: string, openAt: number): boolean => {
    let depth = 0;
    for (let i = openAt; i < expr.length; i++) {
      const c = expr[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skipString(expr, i) - 1;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) return i === expr.length - 1;
      }
    }
    return false;
  };

  /** A literal value we are willing to emit: our own route, or an inert scheme. */
  const safeLiteral = (value: string, emptyIsSafe = true) =>
    (emptyIsSafe && value === "") ||
    value.startsWith("#") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    (value.startsWith("/") && value[1] !== "/" && value[1] !== "\\");

  /** `item.href`, `backHref`, `HREF[a][b]`, `topicHref(t)` - see the convention. */
  const namedHref = (expr: string): boolean => {
    let head = expr;
    // Drop a trailing call or index so the NAME is what is judged.
    while (/[)\]]$/.test(head)) {
      const open = head.lastIndexOf(head.endsWith(")") ? "(" : "[");
      if (open <= 0) return false;
      head = head.slice(0, open);
    }
    const last = head.split(".").pop() ?? "";
    return /^[A-Za-z_$][\w$]*$/.test(last) && /href$/i.test(last);
  };

  const classify = (expr: string, src: string, seen = new Set<string>()): boolean => {
    let e = expr.trim().replace(/\/\*[\s\S]*?\*\//g, "").trim();
    // A non-null assertion says nothing about the value's provenance.
    while (e.endsWith("!")) e = e.slice(0, -1).trim();
    if (e.startsWith("(") && spansWhole(e, 0)) return classify(e.slice(1, -1), src, seen);
    if (e === "undefined" || e === "null") return true;

    // A ternary: the condition is irrelevant, both branches have to hold.
    // `?`, but not either half of `??` and not the `?` of `?.`.
    const q = topLevelIndex(e, (s, i) =>
      s[i] === "?" && s[i + 1] !== "?" && s[i + 1] !== "." && s[i - 1] !== "?" ? 1 : 0,
    );
    if (q > 0) {
      let depth = 0;
      for (let i = q + 1; i < e.length; i++) {
        const c = e[i];
        if (c === '"' || c === "'" || c === "`") {
          i = skipString(e, i) - 1;
          continue;
        }
        // `?` opens a nested ternary whose own `:` must not be mistaken for
        // this one's - but `??` is not a ternary and `?.` is not either, and
        // counting their question marks as openers left the real `:` buried at
        // depth 2 forever. `cond ? a ?? b : c` then classified as unprovable,
        // which is how a correct back-link on the firm page came to be flagged.
        if (c === "?" && (e[i + 1] === "?" || e[i + 1] === ".")) {
          if (e[i + 1] === "?") i++;
          continue;
        }
        if (c === "(" || c === "[" || c === "{" || c === "?") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === ":" && depth === 0) {
          return (
            classify(e.slice(q + 1, i), src, seen) && classify(e.slice(i + 1), src, seen)
          );
        }
      }
      return false;
    }

    // `??` / `||`: every operand is a value this href may take.
    for (const op of ["??", "||"]) {
      const at = topLevelIndex(e, (s, i) => (s.startsWith(op, i) ? op.length : 0));
      if (at > 0) {
        return (
          classify(e.slice(0, at), src, seen) && classify(e.slice(at + op.length), src, seen)
        );
      }
    }

    // A whole-string literal.
    if ((e.startsWith('"') || e.startsWith("'")) && skipString(e, 0) === e.length) {
      return safeLiteral(e.slice(1, -1));
    }
    if (e.startsWith("`") && skipString(e, 0) === e.length) {
      // Only the part before the first interpolation can be judged, and that
      // is enough: what matters is the scheme/authority the browser reads.
      //
      // An EMPTY prefix is not enough, though - `${row.listingUrl}` decides its
      // own scheme and host from whatever the value holds, which is the whole
      // thing this sweep exists to refuse. An empty STRING literal is fine
      // (it renders no link); an empty template prefix is not.
      return safeLiteral(e.slice(1).split("${")[0], false);
    }

    // A lib/safe-url guard wrapping the whole expression.
    for (const g of GUARDS) {
      if (e.startsWith(`${g}(`) && spansWhole(e, g.length)) return true;
    }

    // A bare local const, judged by what it is BOUND to - and this has to come
    // before the naming convention below, or the convention short-circuits it.
    // That ordering was a real bypass: `const sourceHref = row.listingUrl;`
    // followed by `href={sourceHref}` passed, so any raw column could be
    // admitted by renaming the variable that holds it. The convention is for
    // names this file cannot resolve (a prop, an import, a member of an object
    // built elsewhere); a name it CAN resolve is judged, not trusted.
    if (/^[A-Za-z_$][\w$]*$/.test(e) && !seen.has(e)) {
      seen.add(e);
      const bind = new RegExp(`\\bconst\\s+${e}\\s*=\\s*([^;]*);`).exec(src);
      if (bind) return classify(bind[1], src, seen);
    }

    if (namedHref(e)) return true;

    return false;
  };

  // ----------------------------------------------------------------- tests

  const debtKey = (f: string, e: string) => `${f}\u0000${e}`;
  const debt = new Set(KNOWN_UNGUARDED.map(([f, e]) => debtKey(f, e)));

  test("every href in src/app and src/components is provably safe", () => {
    const offences: string[] = [];
    let swept = 0;
    for (const root of SWEEP_ROOTS) {
      for (const full of tsxFiles(root)) {
        const rel = path.relative(process.cwd(), full);
        const src = fs.readFileSync(full, "utf8");
        for (const { expr, line } of hrefExpressions(src)) {
          swept++;
          if (classify(expr, src)) continue;
          if (debt.has(debtKey(rel, expr.trim()))) continue;
          offences.push(`${rel}:${line}  href={${expr.trim()}}`);
        }
      }
    }
    assert.ok(swept > 100, `the sweep found only ${swept} hrefs - the scanner is broken`);
    assert.deepEqual(
      offences,
      [],
      `${offences.length} href(s) emit a value this test cannot prove is safe. Route each ` +
        `through lib/safe-url (externalHref), or - if it genuinely takes no outside ` +
        `input - add it to KNOWN_UNGUARDED with a one-line reason:\n  ` +
        offences.join("\n  "),
    );
  });

  test("the debt list has no stale entries", () => {
    for (const [file, expr, reason] of KNOWN_UNGUARDED) {
      assert.ok(reason.length > 10, `${file} / ${expr} needs a real reason`);
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const found = hrefExpressions(src).some((h) => h.expr.trim() === expr);
      assert.ok(found, `${file} no longer emits href={${expr}} - remove this debt entry`);
    }
  });

  test("the sites fixed in this pass are not on the debt list", () => {
    for (const [file, expr] of FIXED_IN_THIS_PASS) {
      assert.equal(
        debt.has(debtKey(file, expr)),
        false,
        `${file} / ${expr} was guarded on purpose - it must not be excused`,
      );
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      assert.match(src, /from "@\/lib\/safe-url"/, `${file} does not import lib/safe-url`);
      assert.ok(src.includes(expr), `${expr} is no longer in ${file} - update this list`);
    }
  });

  test("the classifier accepts what it should and refuses what it should not", () => {
    const src = [
      "const linkedin = safeHttpUrl(profile.linkedinUrl);",
      "const raw = row.linkedinUrl;",
      // A raw column renamed to look like the naming convention, and the same
      // value laundered through a second hop. Both of these PASSED until the
      // binding was checked before the convention.
      "const sourceHref = row.listingUrl;",
      "const laundered = sourceHref;",
      // The shape that exposed the depth tracker counting `??` as a nested
      // ternary: the real colon ended up buried and the whole thing read as
      // unprovable, which flagged a correct back-link.
      "const backHref = cond ? externalHref(from) ?? null : '/discovery';",
    ].join("\n");
    for (const ok of [
      '"/dashboard"',
      '`/u/${id}`',
      '`mailto:${email}`',
      '"#top"',
      "undefined",
      "externalHref(p.sourceUrl)!",
      "externalHref(w.applyUrl) ?? undefined",
      "cond ? `/api/postings/${p.id}/apply` : externalHref(p.applicationUrl)!",
      "item.href",
      "HREF[audience][mode]",
      "topicHref(t)",
      "linkedin",
      "backHref",
      "cond ? externalHref(from) ?? null : '/discovery'",
    ]) {
      assert.ok(classify(ok, src), `the classifier refused the safe expression ${ok}`);
    }
    for (const bad of [
      "row.linkedinUrl",
      "p.applicationUrl",
      "trackedApply ?? application.applicationUrl",
      "club.websiteUrl",
      '`https://${firm.website}`',
      '"javascript:alert(1)"',
      '"//evil.example/x"',
      "raw",
      "cond ? `/ok` : contact.sourceUrl",
      "maybeUrl!",
      // Renaming the variable that holds a raw column must not launder it, in
      // one hop or two.
      "sourceHref",
      "laundered",
      // A template that begins with an interpolation decides its own scheme and
      // host from whatever the value holds.
      "`${row.listingUrl}`",
      "`${raw}/apply`",
      // A safe fallback does not make the first operand safe: `??` only falls
      // through when the raw value is null, so the raw value is what renders.
      'row.listingUrl ?? "/safe"',
      'true ? row.listingUrl : "/safe"',
      // A cast says nothing about provenance.
      "row.linkedinUrl as string",
    ]) {
      assert.equal(classify(bad, src), false, `the classifier accepted ${bad}`);
    }
  });

  /**
   * The one place the `*href` naming convention could be undermined: a stored
   * column literally called `href`. All three that exist are written by our
   * own notification generators and hold in-app routes. A fourth means the
   * convention has to be re-argued rather than silently extended.
   */
  test("no stored column named href carries an outside URL", () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "src/db/schema.ts"), "utf8");
    const columns = schema.match(/href:\s*text\("href"\)/g) ?? [];
    assert.equal(
      columns.length,
      3,
      `src/db/schema.ts declares ${columns.length} href columns, not the 3 known internal ` +
        "notification/task ones - re-check the naming convention in this file's header",
    );
  });

  test("the tracked-application write carries only a guarded URL", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/applications/TrackToggle.tsx"), "utf8");
    // externalHref, not safeHttpUrl: safeHttpUrl only checks the scheme, so it
    // accepted a userinfo-disguised host, an IP literal and a private suffix -
    // precisely the legacy rows this read boundary exists to stop.
    assert.match(src, /applicationUrl: externalHref\(applicationUrl\) \?\? ""/);
  });
});

/**
 * The WRITE boundary for the three link fields a person fills in.
 *
 * The render guards above are a backstop for rows already stored. These are
 * the rules that stop a new one: all three fields were `z.string().max(500)`,
 * which is a length limit and not a URL check, so `javascript:alert(1)` typed
 * into the contact form or pasted into a CSV cell was stored verbatim.
 */
describe("the write boundary: the link fields a person types", () => {
  const contact = (linkedinUrl: string) =>
    contactSchema.safeParse({
      name: "Dana Reed",
      linkedinUrl,
      relationshipStatus: "not_contacted" as const,
    });

  const application = (applicationUrl: string) =>
    applicationSchema.safeParse({
      firm: "Acme",
      role: "2027 Summer Analyst",
      status: "not_started" as const,
      applicationUrl,
    });

  test("contactSchema refuses a LinkedIn field that is not a linkedin.com link", () => {
    for (const raw of [...HOSTILE, "https://linkedin.com.evil.example/in/x", "https://evil.example/in/x"]) {
      assert.equal(contact(raw).success, false, `stored linkedinUrl ${JSON.stringify(raw)}`);
    }
  });

  test("contactSchema still takes a real profile, and an empty field still means not set", () => {
    assert.equal(contact("https://www.linkedin.com/in/dana-reed/").success, true);
    assert.equal(contact("https://linkedin.com/in/dana-reed").success, true);
    assert.equal(contact("").success, true);
    // Omitted entirely, which is what the form posts when the input is blank.
    assert.equal(
      contactSchema.safeParse({ name: "Dana Reed", relationshipStatus: "not_contacted" }).success,
      true,
    );
  });

  test("applicationSchema requires what the render boundary would accept", () => {
    for (const raw of HOSTILE) {
      assert.equal(application(raw).success, false, `stored applicationUrl ${JSON.stringify(raw)}`);
    }
    for (const raw of LEGITIMATE) {
      assert.equal(application(raw).success, true, `turned away applicationUrl ${raw}`);
    }
    // Not LinkedIn-only: it is any employer's apply link.
    assert.equal(application("https://boards.greenhouse.io/acme/jobs/4001").success, true);
    assert.equal(application("").success, true);
    assert.equal(
      applicationSchema.safeParse({ firm: "Acme", role: "SA", status: "not_started" }).success,
      true,
    );
  });

  test("the two refines agree with the render boundary they stand in front of", () => {
    for (const raw of HOSTILE) {
      assert.equal(isPublicWebUrl(raw), false, `isPublicWebUrl accepted ${JSON.stringify(raw)}`);
      assert.equal(isLinkedinUrl(raw), false, `isLinkedinUrl accepted ${JSON.stringify(raw)}`);
      assert.equal(externalHref(raw), undefined, `externalHref accepted ${JSON.stringify(raw)}`);
    }
    // Nothing the write boundary accepts may be dropped by the render boundary,
    // which is the drift that put a dead button on a student's screen.
    for (const raw of [...LEGITIMATE, "https://www.linkedin.com/in/dana-reed/"]) {
      if (isPublicWebUrl(raw) || isLinkedinUrl(raw)) assert.ok(externalHref(raw), `render boundary drops ${raw}`);
    }
  });

  test("the CSV import applies the same LinkedIn rule, dropping the cell rather than the file", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/app/(app)/contacts/import/actions.ts"),
      "utf8",
    );
    // The import has one error string for a whole file, so a bad cell is
    // blanked instead of voiding 2,000 rows - see the comment on the field.
    assert.match(src, /linkedinUrl: z[\s\S]{0,200}?isLinkedinUrl\(v\) \? v : ""/);
    for (const raw of HOSTILE) assert.equal(isLinkedinUrl(raw), false, `kept cell ${JSON.stringify(raw)}`);
    assert.equal(isLinkedinUrl("https://www.linkedin.com/in/dana-reed/"), true);
    assert.equal(isLinkedinUrl(""), true);
  });
});
