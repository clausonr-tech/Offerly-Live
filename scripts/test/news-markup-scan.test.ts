/**
 * Markup from a publisher cannot be made to hang the news job.
 *
 * Feeds, sitemaps and homepages are parsed with patterns rather than an XML
 * library. The obvious patterns for that job - `<item\b[\s\S]*?</item>`,
 * `<link[^>]*>` - backtrack quadratically on markup built from unclosed
 * openers, and a regex runs synchronously on the only thread, so neither the
 * fetch timeout nor the job's concurrency limit can interrupt one. The news
 * run, the desk and the weekly scout share one lock, so a single crafted page
 * would stop the News tab updating until somebody killed the process.
 *
 * Measured on the old patterns, parsing "<item " repeated: 31ms at 30kB,
 * 122ms at 60kB, 490ms at 120kB, 1,970ms at 240kB - four times the work for
 * twice the input, so about five minutes at the 3MB body cap, for one feed,
 * with the news lock held. The same input now parses in under a millisecond.
 *
 * Each test here feeds the crafted shape to the real parser and asserts it
 * comes back in well under a second, AND that an honest feed still parses to
 * exactly what it used to. No network, no database, no model.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { extractImage, parseFeed, parseGoogleNews } from "@/lib/news/parse";
import { enclosedBlocks, enclosedText, openTags, stripTags } from "@/lib/news/scan-tags";
import { parseSitemap } from "@/lib/news/resolve-url";

/** The body cap fetchText applies, so the crafted input is as big as one can be. */
const FEED_CAP = 3_000_000;
/** Generous: the quadratic shape took minutes to hours at this size. */
const BUDGET_MS = 1_000;

function timed(label: string, work: () => void): number {
  const started = performance.now();
  work();
  const took = performance.now() - started;
  assert.ok(took < BUDGET_MS, `${label} took ${Math.round(took)}ms, over the ${BUDGET_MS}ms budget`);
  return took;
}

/** `token` repeated until the string is as long as a capped feed body. */
const flood = (token: string) => token.repeat(Math.ceil(FEED_CAP / token.length));

const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Wire</title>
  <item>
    <title>Bank A buys Bank B for &amp;#36;3 billion</title>
    <link>https://wire.example/a-buys-b</link>
    <description>&lt;p&gt;The deal values Bank B at &lt;b&gt;$3bn&lt;/b&gt;.&lt;/p&gt;</description>
    <pubDate>Tue, 07 Oct 2026 12:00:00 GMT</pubDate>
    <media:content url="https://wire.example/photo.jpg" medium="image" />
  </item>
  <item>
    <title>Fund C raises a fund</title>
    <guid>https://wire.example/fund-c</guid>
    <enclosure url="https://wire.example/fund.jpg" length="1" type="image/jpeg" />
  </item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Insurer D files</title>
    <link rel="self" href="https://d.example/self"/>
    <link rel="alternate" href="https://d.example/story"/>
    <summary>A &lt;i&gt;filing&lt;/i&gt;.</summary>
    <published>2026-10-07T09:00:00Z</published>
  </entry>
</feed>`;

test("an ordinary RSS feed parses to exactly what it always did", () => {
  const items = parseFeed(FEED, { publisher: "Wire", domain: "wire.example" });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Bank A buys Bank B for $3 billion");
  assert.equal(items[0].url, "https://wire.example/a-buys-b");
  // A space where each tag was, and the collapse, exactly as before.
  assert.equal(items[0].description, "The deal values Bank B at $3bn .");
  assert.equal(items[0].imageUrl, "https://wire.example/photo.jpg");
  assert.equal(items[0].publisher, "Wire");
  assert.equal(items[0].publisherDomain, "wire.example");
  assert.equal(items[0].publishedAt?.toISOString(), "2026-10-07T12:00:00.000Z");
  assert.equal(items[1].url, "https://wire.example/fund-c", "a guid stands in for a missing link");
  assert.equal(items[1].imageUrl, "https://wire.example/fund.jpg", "an image enclosure is still found");
});

test("an Atom entry still prefers rel=alternate over rel=self", () => {
  const items = parseFeed(ATOM, { publisher: "D", domain: "d.example" });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://d.example/story");
  assert.equal(items[0].description, "A filing .");
});

test("Google News keeps naming the real publisher from <source>", () => {
  const xml = `<rss><channel><item>
    <title>Bank A buys Bank B - Reuters</title>
    <link>https://news.google.com/rss/articles/abc</link>
    <source url="https://www.reuters.com">Reuters</source>
  </item></channel></rss>`;
  const [item] = parseGoogleNews(xml);
  assert.equal(item.publisher, "Reuters");
  assert.equal(item.publisherDomain, "reuters.com");
  assert.equal(item.title, "Bank A buys Bank B", "the trailing publisher is stripped");
});

test("a feed of unclosed <item> openers parses instantly and yields nothing", () => {
  const hostile = flood("<item ");
  let items: unknown[] = [];
  timed("3MB of unclosed <item", () => {
    items = parseFeed(hostile, { publisher: "Wire", domain: "wire.example" });
  });
  assert.deepEqual(items, []);
});

test("a feed of unclosed <entry> openers parses instantly", () => {
  const hostile = flood("<entry ");
  timed("3MB of unclosed <entry", () => parseFeed(hostile, { publisher: "W", domain: "w.example" }));
});

test("one real item wrapped around unclosed inner openers still parses, instantly", () => {
  for (const opener of ["<title ", "<link ", "<media:content ", "<img ", "<enclosure ", "<source "]) {
    const hostile = `<rss><channel><item><title>Real</title><link>https://w.example/x</link>${flood(opener)}</item></channel></rss>`;
    timed(`3MB of ${opener.trim()}> inside an item`, () => parseFeed(hostile, { publisher: "W", domain: "w.example" }));
  }
});

test("a description made of unclosed tags is turned to text instantly", () => {
  const hostile = flood("<p ");
  timed("3MB of unclosed <p in a description", () =>
    parseFeed(`<rss><item><title>T</title><link>https://w.example/x</link><description>${hostile}</description></item></rss>`, {
      publisher: "W",
      domain: "w.example",
    }),
  );
});

test("an image enclosure hunted through 3MB of media tags is still instant", () => {
  const hostile = `<item>${flood('<media:content medium="image" ')}</item>`;
  timed("3MB of media:content with no closing bracket", () => extractImage(hostile));
});

test("a sitemap of unclosed <url> openers parses instantly", () => {
  const hostile = flood("<url ");
  let out: ReturnType<typeof parseSitemap> = { entries: [], children: [] };
  timed("3MB of unclosed <url", () => {
    out = parseSitemap(hostile);
  });
  assert.deepEqual(out, { entries: [], children: [] });
});

test("an ordinary sitemap still yields its entries and child sitemaps", () => {
  const xml = `<urlset><url><loc>https://w.example/a-story</loc><news:title>A story</news:title><news:publication_date>2026-10-07</news:publication_date><image:loc>https://w.example/a.jpg</image:loc></url></urlset>`;
  const { entries } = parseSitemap(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].loc, "https://w.example/a-story");
  assert.equal(entries[0].title, "A story");
  assert.equal(entries[0].image, "https://w.example/a.jpg");
  const index = `<sitemapindex><sitemap><loc>https://w.example/news-sitemap.xml</loc><lastmod>2026-10-07</lastmod></sitemap></sitemapindex>`;
  assert.deepEqual(
    parseSitemap(index).children.map((c) => c.loc),
    ["https://w.example/news-sitemap.xml"],
  );
});

test("the scout's feed-link scan over a homepage of unclosed <link> openers is instant", () => {
  const hostile = flood("<link ");
  let found: string[] = [];
  timed("3MB of unclosed <link on a homepage", () => {
    found = openTags(hostile, ["link"], 400).map((t) => t.attrs);
  });
  assert.deepEqual(found, []);

  // The declared feed is still discovered on an ordinary homepage.
  const home = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed/"><link rel="alternate" type="application/rss+xml" href="/comments/feed/"></head></html>`;
  const hrefs = openTags(home, ["link"], 400)
    .filter((t) => /\stype=["']application\/(?:rss|atom)\+xml["']/i.test(t.attrs))
    .map((t) => t.attrs.match(/href=["']([^"']{1,2000})["']/)?.[1]);
  assert.deepEqual(hrefs, ["/feed/", "/comments/feed/"]);
});

test("the scanners themselves keep the meanings the old patterns had", () => {
  assert.deepEqual(
    openTags('<a href="/x">one</a><A HREF="/y">two</A>', ["a"], 10).map((t) => t.attrs.trim()),
    ['href="/x"', 'HREF="/y"'],
  );
  assert.deepEqual(openTags("<article>no</article>", ["a"], 10), [], "<article> does not open an <a>");
  assert.equal(enclosedText("<title>  hi  </title>", "title"), "  hi  ");
  assert.equal(enclosedText("<titles>hi</titles>", "title"), null, "<titles> is not a <title>");
  assert.equal(enclosedText("<title>unclosed", "title"), null);
  assert.deepEqual(enclosedBlocks("<urlset><url><loc>a</loc></url></urlset>", ["url"], { max: 9, blockLimit: 99 }), [
    "<url><loc>a</loc></url>",
  ]);
  assert.equal(stripTags("a <b>bold</b> move"), "a  bold  move");
  assert.equal(stripTags("2 < 3 and 4 > 1"), "2 < 3 and 4 > 1".replace("< 3 and 4 >", " "));
  assert.equal(stripTags("no markup"), "no markup");
});

// ------------------------------------------------- indices and the slice agree
//
// The scanner searched a LOWERCASED copy and sliced the original. toLowerCase
// is not length-preserving: U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE)
// becomes two UTF-16 units, so N of them earlier in the document shifted every
// later index by +N and each slice landed N characters to the right of the
// construct it described - losing the start of the real attributes and picking
// up the text that FOLLOWS the tag's ">".
//
// Every input here is third-party markup, and the values read out of it are the
// story's link, the image served to students and the publisher attribution.

const DOTTED_I = "İ";

test("a character that grows when lowercased does not shift the slice", () => {
  const real = "https://wsj.com/real-story";
  const doc = `<rss><title>${DOTTED_I.repeat(22)}</title><item><link>${real}</link></item></rss>`;
  assert.equal(enclosedText(doc, "link"), real, "the element's own text, not a window beside it");
});

test("an attribute cannot be smuggled in from the text after the tag", () => {
  // The shape that mattered: the <media:content> tag below carries NO url
  // attribute. With the indices drifting, openTags reported one - taken from
  // ordinary text that happens to follow the tag - and the feed parser reads
  // that as the story's image.
  const smuggled = ' url="https://attacker.example/evil.png"';
  const n = smuggled.length + 1;
  const doc =
    `<title>${DOTTED_I.repeat(n)}</title>` +
    `<media:content${" ".repeat(n)}>` +
    `${smuggled} and ordinary text`;
  const [tag] = openTags(doc, ["media:content"]);
  assert.ok(tag, "the tag is still found");
  assert.doesNotMatch(
    tag.attrs,
    /attacker\.example/,
    "an attribute was read from the text following the tag",
  );
});

test("ordinary mixed-case markup is unaffected", () => {
  const doc = `<RSS><Item><LINK>https://ft.com/x</LINK><Media:Content URL="https://ft.com/i.png"/></Item></RSS>`;
  assert.equal(enclosedText(doc, "link"), "https://ft.com/x");
  const [tag] = openTags(doc, ["media:content"]);
  assert.match(tag.attrs, /ft\.com\/i\.png/, "case-insensitive matching still works");
});
