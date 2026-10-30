// The news pipeline's code-only stages: everything that decides what a
// student sees without a model involved. Parsing, the junk filters, dedup
// keys, the checks a model's answer must pass, firm linking, grouping stories
// into events, ranking and the desk's question checks.
//
// The classifier's own accuracy is measured separately, against the golden
// set (npm run news:eval) - these tests are about the code around it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, parseGoogleNews } from "../../src/lib/news/parse";
import { canonicalUrl, filterItem, titleKey, trimDescription, urlHash } from "../../src/lib/news/filters";
import { validateLabel, type ModelItem } from "../../src/lib/news/classify";
import { FirmIndex, normaliseFirmName } from "../../src/lib/news/firm-index";
import { clusterStories, publisherCount, type ClusterInput } from "../../src/lib/news/cluster";
import { scoreEvent } from "../../src/lib/news/rank";
import { validateQuestion } from "../../src/lib/news/desk";
import { edgarStories, parseEdgarAtom, tidyCompanyName } from "../../src/lib/news/edgar";
import { limitStreaks } from "../../src/lib/news/read";
import { googleQueryFor, SOURCE_SEEDS } from "../../src/lib/news/sources";
import { SECTORS } from "../../src/lib/news/types";
import type { RawItem } from "../../src/lib/news/types";

const NOW = new Date("2026-09-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const raw = (over: Partial<RawItem> = {}): RawItem => ({
  title: "KKR agrees to buy Acme for $2 billion",
  url: "https://example.com/a",
  description: null,
  publisher: "Reuters",
  publisherDomain: "reuters.com",
  imageUrl: null,
  publishedAt: hoursAgo(3),
  ...over,
});

// ------------------------------------------------------------------ parsing

test("RSS items keep title, link, date, summary and photo", () => {
  const xml = `<rss><channel><item><title><![CDATA[Swiss Re renews &amp; grows]]></title><link>https://artemis.bm/x</link>
    <pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Rates fell.&lt;/p&gt;</description>
    <media:content url="https://img/x.jpg"/></item></channel></rss>`;
  const [item] = parseFeed(xml, { publisher: "Artemis", domain: "artemis.bm" });
  assert.equal(item.title, "Swiss Re renews & grows");
  assert.equal(item.url, "https://artemis.bm/x");
  assert.equal(item.description, "Rates fell.");
  assert.equal(item.imageUrl, "https://img/x.jpg");
  assert.equal(item.publishedAt?.toISOString(), "2026-09-28T10:00:00.000Z");
});

test("Atom entries use the alternate link, never rel=self", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>X</title>
    <link rel="self" href="https://a/self"/><link rel="alternate" href="https://a/story"/><updated>2026-09-28T10:00:00Z</updated></entry></feed>`;
  assert.equal(parseFeed(xml, { publisher: "A", domain: "a" })[0].url, "https://a/story");
});

test("Google News results lose the ' - Publisher' suffix and carry the publisher's domain", () => {
  const xml = `<rss><item><title>Blackstone raises $10bn - Bloomberg.com</title><link>https://news.google.com/x</link>
    <pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate><source url="https://www.bloomberg.com">Bloomberg.com</source></item></rss>`;
  const [item] = parseGoogleNews(xml);
  assert.equal(item.title, "Blackstone raises $10bn");
  assert.equal(item.publisherDomain, "bloomberg.com");
  assert.equal(item.description, null);
});

// ------------------------------------------------------------------ filters

test("the junk filters drop what live runs found, and keep real news", () => {
  assert.equal(filterItem(raw(), NOW).keep, true);
  const reason = (item: RawItem) => (filterItem(item, NOW) as { reason: string }).reason;
  assert.equal(reason(raw({ title: "Is now a good time to refinance your mortgage?" })), "consumer");
  assert.equal(reason(raw({ title: "3 stocks to buy before the Fed meets" })), "ticker_bait");
  assert.equal(reason(raw({ title: "Law firm reminds investors of class action deadline" })), "press_release");
  assert.equal(reason(raw({ title: "My husband got a $42,000 bonus. Should we pay the mortgage?" })), "first_person");
  assert.equal(reason(raw({ title: "5 ways to save on car insurance this year" })), "consumer");
  assert.equal(reason(raw({ title: "Should you move your 401(k) into bonds?" })), "consumer");
  assert.equal(reason(raw({ publisherDomain: "tradingview.com" })), "blocked_publisher");
  assert.equal(reason(raw({ publishedAt: hoursAgo(80) })), "too_old");
  assert.equal(reason(raw({ publishedAt: null })), "no_date");
});

test("consumer-finance news about an industry is kept for the classifier - only advice is dropped", () => {
  for (const title of [
    "Credit card delinquencies hit a 14-year high",
    "Homebuyers rush to lock in rates as mortgage lenders see a surge",
    "Allstate raises home insurance premiums in California",
    "Student loan servicer Nelnet cuts 400 jobs",
  ]) {
    assert.equal(filterItem(raw({ title }), NOW).keep, true, title);
  }
});

test("regulators get a week, everything else three days", () => {
  assert.equal(filterItem(raw({ publishedAt: hoursAgo(100) }), NOW, 7 * 24).keep, true);
  assert.equal(filterItem(raw({ publishedAt: hoursAgo(100) }), NOW).keep, false);
});

test("blocked language in a publisher's own headline never reaches a student", () => {
  assert.equal((filterItem(raw({ title: "What the fuck happened to bank stocks" }), NOW) as { reason: string }).reason, "blocked_language");
});

test("tracking parameters and AMP do not make a new story", () => {
  assert.equal(canonicalUrl("https://www.x.com/a/b/?utm_source=rss&id=3#top"), "https://x.com/a/b?id=3");
  assert.equal(urlHash("https://x.com/a?utm_medium=feed"), urlHash("https://www.x.com/a/"));
});

test("syndicated copies of one headline share a title key", () => {
  assert.equal(titleKey("Fed holds rates steady - Reuters"), titleKey("Fed Holds Rates Steady | Yahoo Finance"));
  assert.notEqual(titleKey("Fed holds rates"), titleKey("Fed cuts rates"));
});

test("a summary that only repeats the headline is not stored", () => {
  assert.equal(trimDescription("Fed holds rates steady", "Fed holds rates steady"), null);
  assert.ok((trimDescription("x ".repeat(400), "t") ?? "").length <= 401);
});

// ------------------------------------------------------------------ the checks on a model's answer

const answer = (over: Partial<ModelItem> = {}): ModelItem => ({
  id: "s1",
  relevant: true,
  abstain: null,
  sectors: ["private_equity"],
  story_type: "ma",
  worthiness: 4,
  entities: [{ name: "KKR", role: "acquirer" }],
  amount_usd: 2e9,
  region: "us",
  ...over,
});
const story = { title: "KKR agrees to buy Acme for $2 billion", description: null };

test("an entity not in the text is dropped - the model cannot invent or 'correct' a name", () => {
  const v = validateLabel(answer({ entities: [{ name: "KKR", role: "acquirer" }, { name: "Kohlberg Kravis Roberts", role: "acquirer" }] }), story)!;
  assert.deepEqual(v.entities.map((e) => e.name), ["KKR"]);
});

test("an amount needs a money figure in the text", () => {
  assert.equal(validateLabel(answer(), story)!.amountUsd, 2e9);
  assert.equal(validateLabel(answer(), { title: "KKR agrees to buy Acme", description: null })!.amountUsd, null);
});

test("other_finance is never an extra label, and bad sectors are removed", () => {
  const v = validateLabel(answer({ sectors: ["private_equity", "other_finance", "crypto"] }), story)!;
  assert.deepEqual(v.sectors, ["private_equity"]);
});

test("a relevant answer with no usable sector is rejected for a retry", () => {
  assert.equal(validateLabel(answer({ sectors: ["crypto"] }), story), null);
});

test("sectors come from the model as given - no sector is added in code", () => {
  // The investment banking rule that used to add IB to every M&A story was
  // removed on 29 September 2026: with Sonnet it only cost precision (see RESULTS.md).
  const deal = { title: "AMD to buy AI startup Nexa for $4.1 billion", description: null };
  assert.deepEqual(validateLabel(answer({ sectors: ["venture_capital"], entities: [] }), deal)!.sectors, ["venture_capital"]);
});

test("a not-relevant answer carries no sectors", () => {
  const v = validateLabel(answer({ relevant: false, abstain: "consumer", sectors: ["insurance"] }), story)!;
  assert.deepEqual(v.sectors, []);
  assert.equal(v.abstain, "consumer");
});

// ------------------------------------------------------------------ firm linking

test("firm names link exactly, short names only when unambiguous", () => {
  const index = new FirmIndex([
    { id: "apollo", name: "Apollo Global Management", hasVerifiedProgram: true },
    { id: "apollo-health", name: "Apollo Health Ventures", hasVerifiedProgram: false },
    { id: "citadel", name: "Citadel", hasVerifiedProgram: true },
    { id: "citadel-sec", name: "Citadel Securities", hasVerifiedProgram: true },
    { id: "bx", name: "Blackstone Inc.", hasVerifiedProgram: true },
    { id: "gs1", name: "Goldman Wealth Management", hasVerifiedProgram: false },
    { id: "gs2", name: "Goldman Wealth Management, LLC", hasVerifiedProgram: false },
  ]);
  assert.equal(index.lookup("Apollo"), "apollo");
  assert.equal(index.lookup("Citadel"), "citadel");
  assert.equal(index.lookup("Citadel Securities"), "citadel-sec");
  assert.equal(index.lookup("Blackstone"), "bx");
  assert.equal(index.lookup("Goldman Wealth Management"), null, "two firms, so neither");
  assert.equal(index.lookup("Acme"), null);
  assert.equal(normaliseFirmName("J.P. Morgan & Co."), "jp morgan and");
});

// ------------------------------------------------------------------ grouping and ranking

const member = (id: string, title: string, over: Partial<ClusterInput> = {}): ClusterInput => ({
  id,
  title,
  publishedAt: hoursAgo(5),
  storyType: "ma",
  amountUsd: null,
  actors: [],
  publisher: id,
  alsoPublishedBy: [],
  ...over,
});

test("reports of one event group together; a different event by the same firm does not", () => {
  const groups = clusterStories([
    member("reuters", "KKR to buy Acme in $2 billion deal", { actors: ["firm:kkr"], amountUsd: 2e9 }),
    member("wsj", "KKR agrees $2.05bn takeover of Acme Corp", { actors: ["firm:kkr"], amountUsd: 2.05e9, publishedAt: hoursAgo(4) }),
    member("ft", "KKR raises $20bn for its latest buyout fund", { actors: ["firm:kkr"], storyType: "fund_raise", amountUsd: 2e10 }),
  ]);
  assert.equal(groups.size, 2);
  const deal = [...groups.values()].find((g) => g.length === 2)!;
  assert.deepEqual(deal.map((m) => m.id).sort(), ["reuters", "wsj"]);
  assert.equal(publisherCount(deal), 2);
});

test("the same firm's deal reported with and without an amount is one event", () => {
  const groups = clusterStories([
    member("bi", "One of AI's top researchers is joining AMD in an $8 billion deal", { actors: ["firm:amd"], amountUsd: 8e9 }),
    member("mw", "AMD makes a big bet on the next era of AI with World Labs acquisition", { actors: ["firm:amd", "name:world labs"], publishedAt: hoursAgo(3) }),
  ]);
  assert.equal(groups.size, 1);
});

test("a cluster keeps its earliest story's id, so desk picks stay pointed at it", () => {
  const groups = clusterStories([
    member("late", "Fed holds rates steady as inflation cools", { publishedAt: hoursAgo(1) }),
    member("early", "Fed holds rates steady as inflation cools", { publishedAt: hoursAgo(6) }),
  ]);
  assert.deepEqual([...groups.keys()], ["early"]);
});

test("stories more than 48 hours apart are never the same event", () => {
  const groups = clusterStories([
    member("a", "Fed holds rates steady", { publishedAt: hoursAgo(60) }),
    member("b", "Fed holds rates steady", { publishedAt: hoursAgo(2) }),
  ]);
  assert.equal(groups.size, 2);
});

const event = { worthiness: 4, storyType: "ma", eligibleSectors: ["private_equity" as const], primarySector: "private_equity" as const, bestTier: "major", publisherCount: 1, salientFirm: false, amountUsd: null, firstSeenAt: hoursAgo(2) };

test("an event scores only on the tabs it is eligible for", () => {
  const scores = scoreEvent(event, NOW);
  assert.deepEqual(Object.keys(scores).sort(), ["main", "private_equity"]);
});

test("corroboration, a bigger deal and freshness each raise the score", () => {
  const base = scoreEvent(event, NOW).private_equity;
  assert.ok(scoreEvent({ ...event, publisherCount: 3 }, NOW).private_equity > base);
  assert.ok(scoreEvent({ ...event, amountUsd: 5e9 }, NOW).private_equity > base);
  assert.ok(scoreEvent({ ...event, firstSeenAt: hoursAgo(40) }, NOW).private_equity < base);
});

test("trade press fills its own tab but never Main", () => {
  const scores = scoreEvent({ ...event, bestTier: "trade" }, NOW);
  assert.ok(scores.private_equity > 0);
  assert.equal(scores.main, undefined);
});

test("no publisher takes more than two slots in a row", () => {
  const out = limitStreaks([{ source: "A" }, { source: "A" }, { source: "A" }, { source: "B" }]);
  assert.deepEqual(out.map((x) => x.source), ["A", "A", "B", "A"]);
});

// ------------------------------------------------------------------ the desk's questions

test("a desk question may not state a number the story does not", () => {
  const s = { headline: "Blackstone raises $10bn for real estate debt", summary: null };
  assert.ok(validateQuestion("How is Blackstone deploying a $10bn real estate debt fund in this market?", s));
  assert.equal(validateQuestion("Will Blackstone's $12bn fund change CRE lending?", s), null);
  assert.equal(validateQuestion("What the fuck is Blackstone doing?", s), null);
});

// ------------------------------------------------------------------ SEC filings

test("EDGAR: S-1s become IPO stories, SPACs do not, and only activists' 13Ds count", () => {
  const entry = (title: string, acc: string) =>
    `<entry><title>${title}</title><link rel="alternate" href="https://www.sec.gov/Archives/${acc}-index.htm"/><updated>2026-09-28T16:00:00-04:00</updated><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
  const xml = `<feed>${[
    entry("S-1 - ACME ROBOTICS, INC. (0001234567) (Filer)", "0001234567-26-000001"),
    entry("S-1 - Blue Sky Acquisition Corp (0001234568) (Filer)", "0001234568-26-000001"),
    entry("SCHEDULE 13D - TARGET CO (0000000001) (Subject)", "0009999999-26-000001"),
    entry("SCHEDULE 13D - Elliott Investment Management L.P. (0000000002) (Filed by)", "0009999999-26-000001"),
    entry("SCHEDULE 13D - SMITH FAMILY TRUST (0000000003) (Filed by)", "0009999999-26-000002"),
    entry("SCHEDULE 13D - OTHER CO (0000000004) (Subject)", "0009999999-26-000002"),
  ].join("")}</feed>`;
  const stories = edgarStories(parseEdgarAtom(xml));
  assert.deepEqual(stories.map((s) => s.title), [
    "Acme Robotics files a registration statement (S-1)",
    "Elliott Investment Management discloses an activist stake in Target (13D)",
  ]);
  // A registration statement is confirmation, not a card: the feed cannot
  // tell an IPO from a resale by a listed company. The 13D is shown.
  assert.deepEqual(stories.map((s) => s.worthiness), [1, 3]);
  assert.deepEqual(stories[0].entities, [{ name: "Acme Robotics", role: "issuer" }]);
  assert.equal(tidyCompanyName("ACME ROBOTICS, INC."), "Acme Robotics");
});

// ------------------------------------------------------------------ the registry

test("every sector has a Google search short enough for Google to honour the date filter", () => {
  for (const s of SECTORS) {
    const terms = googleQueryFor(s).split(") (")[0];
    assert.ok((terms.match(/ OR /g) ?? []).length <= 3, `${s} has more than four terms`);
  }
});

test("every trade source names the sectors it is trusted for, and ids are unique", () => {
  for (const s of SOURCE_SEEDS) if (s.tier === "trade") assert.ok(s.sectors.length > 0, s.id);
  assert.equal(new Set(SOURCE_SEEDS.map((s) => s.id)).size, SOURCE_SEEDS.length);
});

// ------------------------------------------------------------------ quality gates (29 September 2026)

import { aiImageMarker, hasRumourLanguage, isUnconfirmed } from "../../src/lib/news/quality";

test("an image labelled AI-made in its own metadata is caught", () => {
  assert.ok(aiImageMarker(`<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>`));
  assert.ok(aiImageMarker(`<xmp:CreatorTool>Midjourney v7</xmp:CreatorTool>`));
  assert.ok(aiImageMarker(`xmp:CreatorTool="Adobe Firefly Image 3"`));
});

test("a real photo whose caption mentions an AI tool is not flagged", () => {
  // Insurance Journal, 29 September 2026: a phone showing OpenAI's logo, keywords include DALL-E.
  const caption = `<dc:description><rdf:li>OpenAI is an American company known for ChatGPT and DALL-E: POLTAVA, UKRAINE</rdf:li></dc:description><rdf:li>dall-e</rdf:li><xmp:CreatorTool>Adobe Photoshop 25.1</xmp:CreatorTool>`;
  assert.equal(aiImageMarker(caption), null);
  assert.equal(aiImageMarker(`<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture</Iptc4xmpExt:DigitalSourceType>`), null);
});

test("rumour language is recognised, confirmed reporting is not", () => {
  assert.ok(hasRumourLanguage("Evercore in talks to buy boutique adviser, sources say"));
  assert.ok(hasRumourLanguage("KKR weighs sale of Acme"));
  assert.ok(hasRumourLanguage("Blackstone said to be exploring a bid for Acme"));
  assert.equal(hasRumourLanguage("KKR agrees to buy Acme for $2 billion"), false);
  assert.equal(hasRumourLanguage("Fed holds rates steady"), false);
});

test("unconfirmed means one outlet, all rumour, no filing - and a second outlet clears it", () => {
  const rumour = { title: "Evercore in talks to buy Acme, sources say", description: null, tier: "major" };
  assert.equal(isUnconfirmed([rumour], 1), true);
  assert.equal(isUnconfirmed([rumour], 2), false);
  assert.equal(isUnconfirmed([rumour, { title: "Acme files 8-K on merger agreement", description: null, tier: "primary" }], 1), false);
  assert.equal(isUnconfirmed([{ ...rumour, title: "Evercore agrees to buy Acme" }], 1), false);
});

test("an unconfirmed event ranks lower and is marked, without becoming a tab of its own", () => {
  const confirmed = scoreEvent(event, NOW);
  const rumoured = scoreEvent({ ...event, unconfirmed: true }, NOW);
  assert.ok(rumoured.private_equity < confirmed.private_equity);
  assert.equal(rumoured.unconfirmed, 1);
  assert.equal(confirmed.unconfirmed, undefined);
});

test("a story rated 1 of 4 reaches no tab at all", () => {
  assert.deepEqual(scoreEvent({ ...event, worthiness: 1 }, NOW), {});
});

test("speculation is its own reason for leaving a story out", () => {
  const v = validateLabel(answer({ relevant: false, abstain: "speculative", sectors: [] }), story)!;
  assert.equal(v.relevant, false);
  assert.equal(v.abstain, "speculative");
});

// ------------------------------------------------------------------ specialties and the student digest (30 September 2026)

import { assembleDigest, editionDate, type DigestCandidate } from "../../src/lib/news/digest";

test("a specialty survives only inside one of the story's own sectors", () => {
  const v = validateLabel(
    answer({ sectors: ["investment_banking"], specialties: ["Healthcare Coverage", "Reinsurance", "M&A Advisory", "Invented Desk"] }),
    story,
  )!;
  assert.deepEqual(v.specialties, ["Healthcare Coverage", "M&A Advisory"]);
  assert.deepEqual(validateLabel(answer({ relevant: false, abstain: "promo", sectors: [], specialties: ["Reinsurance"] }), story)!.specialties, []);
});

const cand = (id: string, over: Partial<DigestCandidate> = {}): DigestCandidate => ({
  clusterId: id,
  story: { title: id, link: `https://x/${id}`, source: "Reuters", sourceDomain: "reuters.com", publishedAt: null, imageUrl: null, outlets: 1, paywall: false, unconfirmed: false, opinion: false },
  sectors: ["investment_banking"],
  specialties: [],
  scores: { investment_banking: 0.5, main: 0.5 },
  firmIds: [],
  firstSeenAt: hoursAgo(5),
  ...over,
});

test("the digest leads with the student's firms, labelled with the firm", () => {
  const sections = assembleDigest({
    candidates: [cand("evercore-deal", { firmIds: ["evercore"], scores: { investment_banking: 0.2 } }), cand("big-ib", { scores: { investment_banking: 0.9 } })],
    sectors: ["investment_banking"],
    specialties: [],
    topFirms: [{ id: "evercore", name: "Evercore" }],
    now: NOW,
  });
  assert.equal(sections[0].title, "Your firms");
  assert.equal(sections[0].stories[0].because, "Evercore");
  // An event appears once: the Evercore deal is not repeated under Investment Banking.
  assert.deepEqual(sections[1].stories.map((s) => s.title), ["big-ib"]);
});

test("within an industry, the student's specialty comes first, then the rest fill in", () => {
  const sections = assembleDigest({
    candidates: [
      cand("tmt-deal", { specialties: ["TMT Coverage"], scores: { investment_banking: 0.9 } }),
      cand("healthcare-deal", { specialties: ["Healthcare Coverage"], scores: { investment_banking: 0.1 } }),
      cand("other-deal", { scores: { investment_banking: 0.5 } }),
    ],
    sectors: ["investment_banking"],
    specialties: ["Healthcare Coverage"],
    topFirms: [],
    now: NOW,
  });
  assert.deepEqual(sections[0].stories.map((s) => s.title), ["healthcare-deal", "tmt-deal", "other-deal"]);
  assert.equal(sections[0].stories[0].because, "Healthcare Coverage");
  assert.equal(sections[0].stories[1].because, null);
});

test("industries follow the order the student picked them, and empty ones are left out", () => {
  const sections = assembleDigest({
    candidates: [cand("pe", { sectors: ["private_equity"], scores: { private_equity: 0.4 } }), cand("ib")],
    sectors: ["private_equity", "insurance", "investment_banking"],
    specialties: [],
    topFirms: [],
    now: NOW,
  });
  assert.deepEqual(sections.map((s) => s.title), ["Private Equity", "Investment Banking"]);
});

test("a student with no interests and no firm news gets the day's top stories", () => {
  const sections = assembleDigest({ candidates: [cand("a"), cand("b", { scores: { investment_banking: 0.3 } })], sectors: [], specialties: [], topFirms: [], now: NOW });
  assert.equal(sections[0].kind, "top");
  assert.equal(sections[0].stories.length, 1, "only stories with a Main score");
});

test("stale firm news drops out after a week, stale sector news after three days", () => {
  const sections = assembleDigest({
    candidates: [cand("old-firm", { firmIds: ["f"], firstSeenAt: hoursAgo(200) }), cand("old-sector", { firstSeenAt: hoursAgo(100) })],
    sectors: ["investment_banking"],
    specialties: [],
    topFirms: [{ id: "f", name: "F" }],
    now: NOW,
  });
  assert.deepEqual(sections, []);
});

test("the edition turns over at 5am in the student's time zone", () => {
  assert.equal(editionDate(new Date("2026-09-30T08:30:00Z"), "America/New_York"), "2026-09-29"); // 4:30am New York
  assert.equal(editionDate(new Date("2026-09-30T09:30:00Z"), "America/New_York"), "2026-09-30"); // 5:30am New York
  assert.equal(editionDate(new Date("2026-09-30T09:30:00Z"), "Not/AZone"), "2026-09-30");
});

// ------------------------------------------------------------------ publishers without a feed (30 September 2026)

import { googleResultAllowed } from "../../src/lib/news/ingest";

test("a scout-added Google source brings in only its own publisher; the sector searches only the majors", () => {
  const site = { domain: "hedgefundalpha.com" } as Parameters<typeof googleResultAllowed>[0];
  const sectorSearch = { domain: "news.google.com" } as Parameters<typeof googleResultAllowed>[0];
  assert.equal(googleResultAllowed(site, "hedgefundalpha.com"), true);
  assert.equal(googleResultAllowed(site, "news.hedgefundalpha.com"), true);
  assert.equal(googleResultAllowed(site, "tradingview.com"), false);
  assert.equal(googleResultAllowed(sectorSearch, "reuters.com"), true);
  assert.equal(googleResultAllowed(sectorSearch, "hedgefundalpha.com"), false);
});

// ------------------------------------------------------------------ language and takedowns

test("a headline in another script is dropped before a model call; accents and one foreign word are not", () => {
  const at = new Date("2026-09-30T12:00:00Z");
  const item = (title: string): RawItem => ({ title, url: "https://example.com/a", publishedAt: new Date("2026-09-30T10:00:00Z"), description: null, publisher: "X", publisherDomain: "example.com", imageUrl: null });
  assert.deepEqual(filterItem(item("दिल्ली के इन इलाकों में घटेगा ट्रैफिक! गृह मंत्री अमित शाह"), at), { keep: false, reason: "not_english" });
  assert.deepEqual(filterItem(item("Société Générale cuts 900 jobs in Paris"), at), { keep: true });
  assert.deepEqual(filterItem(item("Nomura's 野村 unit hires a Tokyo M&A head"), at), { keep: true });
});

import { REPORT_REASONS, isReportReason } from "../../src/lib/news/report-reasons";

test("a report carries one of the fixed reasons and nothing else", () => {
  for (const reason of Object.keys(REPORT_REASONS)) assert.ok(isReportReason(reason));
  assert.equal(isReportReason("free text a student typed"), false);
  assert.equal(isReportReason("toString"), false, "an inherited property is not a reason");
  assert.equal(isReportReason(undefined), false);
});

test("eFinancialCareers is read from its news section, not its job ads", () => {
  const efc = SOURCE_SEEDS.find((s) => s.id === "efinancialcareers")!;
  assert.match(efc.url, /efinancialcareers\.com\/news/);
});

// ------------------------------------------------------------------ photos (30 September 2026)

import { imageInfo, shapeProblem } from "../../src/lib/news/image-probe";
import { articleImage, fullSizeUrl, isGenericImageUrl, shareImages } from "../../src/lib/news/page-image";
import { matchHeadline, parseSitemap, slugWords } from "../../src/lib/news/resolve-url";
import { photoAccepted } from "../../src/lib/news/vision";

test("a photo's real size is read from its bytes, whatever the format", () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(630, 20);
  assert.deepEqual(imageInfo(png), { format: "png", width: 1200, height: 630 });

  // JPEG: SOI, an APP0 segment to skip, then SOF0 with height 675 and width 1200.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xa3, 0x04, 0xb0, 0x03]);
  assert.deepEqual(imageInfo(jpeg), { format: "jpeg", width: 1200, height: 675 });

  const gif = Buffer.from("GIF89a", "latin1");
  const gifFull = Buffer.concat([gif, Buffer.from([0x2c, 0x01, 0xc8, 0x00])]);
  assert.deepEqual(imageInfo(gifFull), { format: "gif", width: 300, height: 200 });

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBP", 8, "latin1");
  webp.write("VP8X", 12, "latin1");
  webp.writeUIntLE(1199, 24, 3);
  webp.writeUIntLE(799, 27, 3);
  assert.deepEqual(imageInfo(webp), { format: "webp", width: 1200, height: 800 });
});

test("only card-sized landscape photos pass; thumbnails, portraits, banners and GIFs do not", () => {
  assert.equal(shapeProblem({ format: "jpeg", width: 1200, height: 675 }), null);
  assert.equal(shapeProblem({ format: "jpeg", width: 300, height: 200 }), "too_small");
  assert.equal(shapeProblem({ format: "jpeg", width: 800, height: 1200 }), "wrong_shape", "a portrait loses the face to a 16:9 crop");
  assert.equal(shapeProblem({ format: "png", width: 1456, height: 500 }), "wrong_shape", "a banner ad shape");
  assert.equal(shapeProblem({ format: "gif", width: 1200, height: 675 }), "animated_or_vector");
  assert.equal(shapeProblem({ format: "jpeg", width: null, height: null }), "too_small");
});

test("the share image and the article's structured-data image are found in the page head", () => {
  const html = `<html><head>
    <meta property="og:image" content="https://cdn.example.com/2026/09/deal.jpg?w=1200&amp;h=630">
    <meta name="twitter:image" content="/img/deal-twitter.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"NewsArticle","image":[{"@type":"ImageObject","url":"https://cdn.example.com/ld.jpg"}]}]}</script>
  </head><body></body></html>`;
  assert.deepEqual(shareImages(html, "https://www.example.com/news/a"), [
    { url: "https://cdn.example.com/2026/09/deal.jpg?w=1200&h=630", source: "share" },
    { url: "https://www.example.com/img/deal-twitter.jpg", source: "share" },
    { url: "https://cdn.example.com/ld.jpg", source: "jsonld" },
  ]);
});

test("the article-body photo is the story's own, never an ad, a rail, a byline or a logo", () => {
  const html = `<body>
    <header><img src="/logo.png" class="site-logo" width="200" height="60"></header>
    <aside class="sidebar"><img src="https://cdn.example.com/sidebar-promo.jpg" width="600" height="400"></aside>
    <article>
      <div class="byline"><img src="https://cdn.example.com/author.jpg" class="author-photo" width="80" height="80"></div>
      <div class="ad-slot"><img src="https://cdn.example.com/banner.jpg" width="728" height="400"></div>
      <img src="https://securepubads.g.doubleclick.net/pixel.jpg" width="600" height="400">
      <p>Blackstone agreed to buy...</p>
      <figure><img data-src="https://cdn.example.com/2026/09/blackstone-hq.jpg" src="data:image/gif;base64,R0lGOD" width="1200" height="675" alt="Blackstone's headquarters"></figure>
      <div class="related-stories"><img src="https://cdn.example.com/other-story.jpg" width="600" height="400"></div>
    </article>
  </body>`;
  assert.deepEqual(articleImage(html, "https://www.example.com/a"), { url: "https://cdn.example.com/2026/09/blackstone-hq.jpg", source: "article" });
  assert.equal(articleImage("<body><p>no article element at all</p><img src='x.jpg'></body>", "https://example.com"), null);
  const srcset = `<article><img srcset="https://c.example.com/a-400.jpg 400w, https://c.example.com/a-1600.jpg 1600w" src="https://c.example.com/a-400.jpg"></article>`;
  assert.equal(articleImage(srcset, "https://example.com")?.url, "https://c.example.com/a-1600.jpg", "the widest in a srcset");
});

test("a photo linking to another story is a teaser, whatever its rail is called; a lightbox link is not", () => {
  // Markets Media's "Related articles" rail, as served on 5 October 2026.
  const html = `<main class="l-main"><article>
    <p>Apollo is expanding daily pricing...</p>
    <a href="https://www.marketsmedia.com/wp-content/uploads/2026/10/apollo-full.jpg"><img src="https://www.marketsmedia.com/wp-content/uploads/2026/10/apollo.jpg" width="1200" height="675"></a>
    <a href="/apollo-expands-daily-pricing-to-all-credit-assets/#top"><img src="https://www.marketsmedia.com/wp-content/uploads/2026/10/apollo-2.jpg" width="1200" height="675"></a>
    <div class="c-other-events-box"><ol class="c-other-events-list">
      <li class="c-other-events-list__item"><div class="c-simple-box"><div class="o-img-wrapper">
        <a href="https://www.marketsmedia.com/baillie-gifford-takes-tokenised-bond-fund-across-four-markets/"><img width="376" height="300" src="https://www.marketsmedia.com/wp-content/uploads/2015/06/basel-committee-376x250.jpg"></a>
      </div></div></li>
    </ol></div>
    <div class="js-slider"><img src="https://www.marketsmedia.com/wp-content/uploads/2019/11/slide.jpg" width="900" height="500"></div>
  </article></main>`;
  assert.deepEqual(
    articleImages(html, "https://www.marketsmedia.com/apollo-expands-daily-pricing-to-all-credit-assets/").map((c) => c.url),
    ["https://www.marketsmedia.com/wp-content/uploads/2026/10/apollo.jpg", "https://www.marketsmedia.com/wp-content/uploads/2026/10/apollo-2.jpg"],
  );
});

test("an unquoted link ending in a slash is still a link: its photo is another story's", () => {
  // Minified pages drop the quotes. "/>" here ends the address, not the tag.
  const html = `<main><article><p>Apollo said...</p>
    <a href=/2026/09/otcx-goes-live/><img src=/uploads/otcx.jpg width=1200 height=675></a>
    <figure><img src=/uploads/apollo.jpg width=1200 height=675></figure>
    <div class="x"/><img src=/uploads/after-self-closing-div.jpg width=1200 height=675>
  </article></main>`;
  assert.deepEqual(
    articleImages(html, "https://www.example.com/2026/10/apollo/").map((c) => c.url),
    ["https://www.example.com/uploads/apollo.jpg", "https://www.example.com/uploads/after-self-closing-div.jpg"],
  );
});

test("a WordPress resized copy leads back to its original upload", () => {
  assert.equal(
    fullSizeUrl("https://www.marketsmedia.com/wp-content/uploads/2014/09/bond-markets-target-intraday-pricing-e1493324931690-150x150.jpg"),
    "https://www.marketsmedia.com/wp-content/uploads/2014/09/bond-markets-target-intraday-pricing-e1493324931690.jpg",
  );
  assert.equal(fullSizeUrl("https://cdn.example.com/photo-573x379.webp?ver=2"), "https://cdn.example.com/photo.webp");
  assert.equal(fullSizeUrl("https://cdn.example.com/photo.jpg"), null);
  assert.equal(fullSizeUrl("https://cdn.example.com/1200x630.jpg"), null, "a name that is only a size has no original to find");
  assert.equal(fullSizeUrl("not a url"), null);
});

test("placeholders, logos and site-wide share cards are recognised by their file name", () => {
  for (const url of [
    "https://www.claimsjournal.com/img/social/cj-social-post-1104x736.png",
    "https://www.insurancejournal.com/img/social/opengraph/ij-social-default-1200x630.png",
    "https://media.pehub.com/uploads/2019/11/PEHub_Logo2.jpg",
    "https://www.reinsurancene.ws/wp-content/uploads/2025/06/ascot-logo-new.png",
  ])
    assert.ok(isGenericImageUrl(url), url);
  assert.equal(isGenericImageUrl("https://media.buyoutsinsider.com/uploads/2026/09/Michael-Drai.jpg"), false);
});

test("a vision verdict shows a photo only when it is a real photo, stock shot or chart that fits the headline", () => {
  assert.ok(photoAccepted({ kind: "news_photo", fitsHeadline: true, note: "" }));
  assert.ok(photoAccepted({ kind: "chart_or_map", fitsHeadline: true, note: "" }));
  assert.ok(photoAccepted({ kind: "concept_stock", fitsHeadline: true, note: "" }), "the publisher's own topic shot");
  assert.equal(photoAccepted({ kind: "news_photo", fitsHeadline: false, note: "" }), false);
  assert.equal(photoAccepted({ kind: "concept_stock", fitsHeadline: false, note: "" }), false);
  for (const kind of ["illustration_or_ai", "logo_or_brand", "ad_or_promo", "text_or_screenshot", "other"] as const) {
    assert.equal(photoAccepted({ kind, fitsHeadline: true, note: "" }), false, kind);
  }
});

test("a Google News story is matched to the publisher's own article by headline, or by the words in its address", () => {
  const xml = `<urlset>
    <url><loc>https://www.wsj.com/finance/banking/piper-sandler-perella-talks-1a2b3c4d</loc>
      <news:news><news:publication_date>2026-09-29T20:00:00Z</news:publication_date><news:title><![CDATA[Piper Sandler Holds Talks to Buy Perella Weinberg]]></news:title></news:news>
      <image:image><image:loc>https://images.wsj.net/im-123.jpg</image:loc></image:image></url>
    <url><loc>https://www.wsj.com/finance/banking/piper-sandler-earnings-5e6f7a8b</loc>
      <news:news><news:title>Piper Sandler Profit Rises on Advisory Fees</news:title></news:news></url>
  </urlset>`;
  const { entries } = parseSitemap(xml);
  assert.equal(entries.length, 2);
  const hit = matchHeadline("Exclusive | Piper Sandler Holds Talks to Buy Perella Weinberg", entries);
  assert.equal(hit?.loc, "https://www.wsj.com/finance/banking/piper-sandler-perella-talks-1a2b3c4d");
  assert.equal(hit?.image, "https://images.wsj.net/im-123.jpg");
  assert.equal(matchHeadline("Piper Sandler names new head of healthcare banking", entries), null, "same company, different story");

  const homepage = [{ loc: "https://www.insurancebusinessmag.com/us/news/breaking-news/insurers-raise-cat-bond-issuance-to-record-high-561234.aspx", title: null, image: null, date: null }];
  assert.deepEqual(slugWords(homepage[0].loc), ["insurers", "raise", "cat", "bond", "issuance", "record", "high"]);
  assert.equal(matchHeadline("Insurers raise cat bond issuance to a record high", homepage)?.loc, homepage[0].loc);
  assert.equal(matchHeadline("Cat bond spreads tighten", homepage), null, "too few shared words to be sure");
});

// ------------------------------------------------------------------ the daily briefing

import { assembleBriefing, bulletIsGrounded, validateBullet, type BriefingPiece } from "../../src/lib/news/briefing";

test("a briefing bullet must cite given stories, state only their numbers, stay short and pass content-limits", () => {
  const byRef = new Map([
    ["s1", { ref: "s1", clusterId: "c1", title: "Clean Max block deal of ₹1,063 crore", summary: "85 lakh shares change hands", publisher: "Mint", link: "https://m/1", storyType: "ecm", publishedAt: new Date() }],
    ["s2", { ref: "s2", clusterId: "c2", title: "Fed holds rates at 4.25%", summary: null, publisher: "Reuters", link: "https://r/2", storyType: "markets_macro", publishedAt: new Date() }],
  ]);
  const ok = validateBullet({ text: "Clean Max saw a ₹1,063 crore block deal as 85 lakh shares traded.", stories: ["s1"] }, byRef);
  assert.deepEqual(ok?.sources, [{ title: "Clean Max block deal of ₹1,063 crore", link: "https://m/1", publisher: "Mint" }]);
  assert.equal(validateBullet({ text: "The Fed held rates at 4.5%.", stories: ["s2"] }, byRef), null, "a number the story does not state");
  assert.equal(validateBullet({ text: "The Fed held rates steady.", stories: ["s9"] }, byRef), null, "a story that was not given");
  assert.equal(validateBullet({ text: "The Fed held rates steady.", stories: [] }, byRef), null, "no source");
  assert.equal(validateBullet({ text: Array(40).fill("word").join(" "), stories: ["s2"] }, byRef), null, "too long");
  assert.equal(validateBullet({ text: "The Fed held rates steady, what the fuck.", stories: ["s2"] }, byRef), null, "content-limits");
  assert.ok(bulletIsGrounded("A $2.5 billion deal", [{ title: "KKR agrees $2.5 billion deal", summary: null }]));
});

test("a student's briefing: their industries' deals, then how markets moved and what it means for everyone, then their industries' markets", () => {
  const src = (link: string) => [{ title: link, link, publisher: "Reuters" }];
  const piece = (scope: string, headings: Record<string, string[]>): BriefingPiece => ({
    scope,
    generatedAt: "2026-09-30T09:00:00.000Z",
    headings: Object.fromEntries(Object.entries(headings).map(([k, links]) => [k, links.map((l) => ({ text: `about ${l}`, sources: src(l) }))])),
  });
  const pieces = [
    piece("general", { deals: ["g-deal"], markets: ["g-mkt"], what_it_means: ["g-mean"], economy_us: ["cpi"], economy_global: [], policy: ["tariff"], recruiting: ["bonus"] }),
    piece("investment_banking", { deals: ["ib-1", "shared"], markets: ["ib-mkt"], trends: [] }),
    piece("private_equity", { deals: ["shared", "pe-1"], markets: [], trends: ["pe-trend"] }),
  ];
  const b = assembleBriefing(pieces, ["investment_banking", "private_equity"])!;
  assert.deepEqual(b.sections.map((s) => s.key), ["deals", "markets", "what_it_means", "your_markets", "economy_us", "policy", "recruiting"], "empty headings are left out");
  assert.deepEqual(b.sections[0].bullets.map((x) => x.sources[0].link), ["ib-1", "shared", "pe-1"], "interleaved by industry, the shared deal once");
  assert.deepEqual(b.sections[1].bullets.map((x) => x.sources[0].link), ["g-mkt"], "how markets moved, for every student");
  assert.deepEqual(b.sections[2].bullets.map((x) => x.sources[0].link), ["g-mean"]);
  assert.deepEqual(b.sections[3].bullets.map((x) => x.sources[0].link), ["ib-mkt", "pe-trend"]);

  const none = assembleBriefing(pieces, [])!;
  assert.equal(none.sections[0].title, "Deals");
  assert.ok(!none.sections.some((s) => s.key === "your_markets"), "no industries, no industry markets");
  assert.deepEqual(none.sections[0].bullets.map((x) => x.sources[0].link), ["g-deal"]);
  assert.equal(assembleBriefing([], ["insurance"]), null);
});

// ------------------------------------------------------------------ the digest layout

import { pickMainStory } from "../../src/lib/news/digest";

test("the main story is the day's top event, and it is not repeated in the sections below", () => {
  const cands = [
    cand("biggest", { scores: { main: 0.9, investment_banking: 0.9 } }),
    cand("old-but-big", { scores: { main: 0.95 }, firstSeenAt: hoursAgo(40) }),
    ...["a", "b", "c", "d", "e", "f"].map((id) => cand(id, { scores: { main: 0.4, investment_banking: 0.4 } })),
  ];
  const main = pickMainStory(cands, NOW)!;
  assert.equal(main.clusterId, "biggest", "the last day first, even over a bigger older story");
  const sections = assembleDigest({ candidates: cands, sectors: ["investment_banking"], specialties: [], topFirms: [], now: NOW, exclude: [main.clusterId] });
  assert.equal(sections[0].stories.length, 4, "four a section");
  assert.ok(!sections.flatMap((s) => s.stories).some((s) => s.title === "biggest"));
  assert.equal(pickMainStory([cand("x", { scores: { investment_banking: 0.5 } })], NOW), null, "nothing on Top stories, no banner");
});

// ------------------------------------------------------------------ the student's paid sources

import { PAID_PUBLISHERS, canRead, capLocked, isPaidPublisherId, paidPublisherOf } from "../../src/lib/news/access";

test("a paid publisher is known by any of its domains; free sources are always readable", () => {
  assert.equal(paidPublisherOf("www.wsj.com")?.id, "wsj");
  assert.equal(paidPublisherOf("markets.ft.com")?.id, "ft");
  assert.equal(paidPublisherOf("buyoutsinsider.com")?.id, "pei", "one PEI Media subscription covers its titles");
  assert.equal(paidPublisherOf("reuters.com"), null);
  assert.equal(canRead("reuters.com", []), true);
  assert.equal(canRead("wsj.com", []), false);
  assert.equal(canRead("wsj.com", ["wsj"]), true);
  assert.equal(canRead("bloomberg.com", ["wsj"]), false);
  assert.ok(isPaidPublisherId("bloomberg"));
  assert.equal(isPaidPublisherId("<script>"), false);
  assert.equal(new Set(PAID_PUBLISHERS.map((p) => p.id)).size, PAID_PUBLISHERS.length, "ids are unique");
});

test("every source the registry marks paywalled is one a student can tick", () => {
  for (const s of SOURCE_SEEDS.filter((x) => x.paywall)) assert.ok(paidPublisherOf(s.domain), `${s.id} (${s.domain}) is missing from PAID_PUBLISHERS`);
});

test("locked stories past the cap drop out; the rest keep their order", () => {
  const items = ["a", "L1", "b", "L2", "c", "L3"];
  assert.deepEqual(capLocked(items, (x) => x.startsWith("L"), 1), ["a", "L1", "b", "c"]);
  assert.deepEqual(capLocked(items, (x) => x.startsWith("L"), 0), ["a", "b", "c"]);
});

test("a digest row shows at most one story the student cannot open, and the main story is one they can", () => {
  const cands = [
    cand("locked-big", { scores: { main: 0.95, investment_banking: 0.95 }, locked: true }),
    cand("locked-2", { scores: { main: 0.9, investment_banking: 0.9 }, locked: true }),
    ...["a", "b", "c", "d"].map((id) => cand(id, { scores: { main: 0.4, investment_banking: 0.4 } })),
  ];
  const main = pickMainStory(cands, NOW)!;
  assert.equal(main.clusterId, "a", "the top readable story, not the bigger locked one");
  const sections = assembleDigest({ candidates: cands, sectors: ["investment_banking"], specialties: [], topFirms: [], now: NOW, exclude: [main.clusterId] });
  const titles = sections[0].stories.map((s) => s.title);
  assert.equal(titles.length, 4);
  assert.equal(titles.filter((t) => t.startsWith("locked")).length, 1);
  assert.equal(pickMainStory([cand("only-locked", { scores: { main: 0.5 }, locked: true })], NOW)?.clusterId, "only-locked", "a locked story rather than no banner");
});

import { sameInterests } from "../../src/lib/news/digest";

test("a stored digest is reused only while the student's industries and specialties are unchanged", () => {
  const stored = { sectors: ["investment_banking", "private_equity"] as ("investment_banking" | "private_equity")[], specialties: ["M&A Advisory", "Buyouts"] };
  assert.ok(sameInterests(stored, { sectors: ["investment_banking", "private_equity"], specialties: ["Buyouts", "M&A Advisory"] }), "specialty order does not matter");
  assert.equal(sameInterests(stored, { sectors: ["investment_banking"], specialties: ["M&A Advisory", "Buyouts"] }), false, "an industry dropped");
  assert.equal(sameInterests(stored, { sectors: ["private_equity", "investment_banking"], specialties: ["M&A Advisory", "Buyouts"] }), false, "industries reordered: the digest follows their order");
  assert.equal(sameInterests(stored, { sectors: ["investment_banking", "private_equity"], specialties: ["M&A Advisory"] }), false, "a specialty dropped");
});

// ------------------------------------------------------------------ security review fixes (30 September 2026)

import { UnsafeUrlError, assertPublicUrl, isPublicAddress, readCapped } from "../../src/lib/news/safe-fetch";

test("the pipeline never fetches an internal address or a non-web scheme", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "151.101.1.69", "192.0.66.220", "2606:4700::6810:84e5"]) assert.ok(isPublicAddress(ip), ip);
  assert.equal(isPublicAddress("192.0.2.10"), false, "the documentation range");
  for (const url of ["http://127.0.0.1:3001/api", "http://localhost/", "http://[::1]/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "http://192.168.0.1/admin", "http://printer.local/"]) {
    await assert.rejects(assertPublicUrl(url), UnsafeUrlError, url);
  }
  assert.equal((await assertPublicUrl("http://8.8.8.8/x")).hostname, "8.8.8.8");
});

test("a response is read only up to its cap, however it is sent", async () => {
  const big = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1000)); c.close(); } }));
  assert.equal(await readCapped(big, 2500, "reject"), null);
  const big2 = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1000).fill(65)); c.close(); } }));
  assert.equal((await readCapped(big2, 2500, "truncate"))?.length, 2500);
  assert.equal((await readCapped(new Response("small"), 2500, "reject"))?.toString(), "small");
});

test("a feed cannot put a javascript: link or photo on a card, or pass its stories off as another publisher's", () => {
  const atom = `<feed><entry><title>Bad</title><link rel="alternate" href="javascript:alert(document.cookie)"/><updated>2026-09-29T10:00:00Z</updated></entry>
    <entry><title>Good</title><link href="https://ok.example/a"/><media:content url="javascript:alert(1)"/><updated>2026-09-29T10:00:00Z</updated></entry></feed>`;
  const items = parseFeed(atom, { publisher: "X", domain: "x.example" });
  assert.deepEqual(items.map((i) => i.url), ["https://ok.example/a"], "the javascript: entry has no usable link");
  assert.equal(items[0].imageUrl, null);

  const spoof = `<rss><channel><item><title>Scoop</title><link>https://smallblog.example/a</link><source url="https://www.wsj.com">The Wall Street Journal</source><pubDate>Mon, 29 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  const [item] = parseFeed(spoof, { publisher: "Small Blog", domain: "smallblog.example" });
  assert.equal(item.publisher, "Small Blog");
  assert.equal(item.publisherDomain, "smallblog.example");
  const [google] = parseGoogleNews(spoof);
  assert.equal(google.publisherDomain, "wsj.com", "Google News names the real publisher there");
});

test("a publisher name with blocked language is dropped like a headline would be", () => {
  const at = new Date("2026-09-30T12:00:00Z");
  const verdict = filterItem({ title: "Markets rise", url: "https://x.example/a", publishedAt: new Date("2026-09-30T10:00:00Z"), description: null, publisher: "Shit Finance Daily", publisherDomain: "x.example", imageUrl: null }, at);
  assert.deepEqual(verdict, { keep: false, reason: "blocked_language" });
});

// ------------------------------------------------------------------ in-article photos and story summaries (30 September 2026)

import { articleImages, articleText } from "../../src/lib/news/page-image";
import { validateSummary } from "../../src/lib/news/summary";

test("every photo in the article body is a candidate, top first, so a bad lead image does not cost the story its photo", () => {
  const html = `<article>
    <img src="https://cdn.example.com/lead-thumb.jpg" width="1200" height="675">
    <div class="newsletter-promo"><img src="https://cdn.example.com/signup.jpg" width="600" height="400"></div>
    <p>KKR agreed to buy Acme.</p>
    <figure><img src="https://cdn.example.com/acme-plant.jpg" width="1200" height="800"></figure>
    <img src="https://cdn.example.com/acme-plant.jpg" width="1200" height="800">
    <img src="https://cdn.example.com/icon.svg">
    <figure><img src="https://cdn.example.com/kkr-office.jpg"></figure>
  </article>`;
  assert.deepEqual(
    articleImages(html, "https://example.com").map((c) => c.url),
    ["https://cdn.example.com/lead-thumb.jpg", "https://cdn.example.com/acme-plant.jpg", "https://cdn.example.com/kkr-office.jpg"],
    "no promo, no SVG, no repeats",
  );
  assert.equal(articleImages(html, "https://example.com", 1).length, 1);
});

test("an article's text is its body paragraphs, without ads, rails, captions or sign-up prompts", () => {
  const html = `<html><body><nav><p>Home Markets Deals Opinion and everything else in the menu</p></nav>
    <article>
      <p class="byline-author">By a reporter who writes about private equity every day</p>
      <p>KKR agreed to buy Acme Corp for $2 billion, the firms said on Tuesday, in its largest deal this year.</p>
      <figure><img src="a.jpg"><figcaption><p>Acme's plant in Ohio, photographed in 2024 for a caption</p></figcaption></figure>
      <div class="ad-slot"><p>Advertisement: buy our product today and save a lot of money</p></div>
      <p>Subscribe to our newsletter to get the latest deals in your inbox every morning.</p>
      <p>The deal values Acme at 12 times earnings &amp; is expected to close in the first quarter of 2027.</p>
      <aside><p>Related: another story that has nothing to do with this one at all</p></aside>
    </article></body></html>`;
  assert.equal(
    articleText(html),
    "KKR agreed to buy Acme Corp for $2 billion, the firms said on Tuesday, in its largest deal this year.\nThe deal values Acme at 12 times earnings & is expected to close in the first quarter of 2027.",
  );
  assert.equal(articleText("<body><p>No article element marks the body of this page at all.</p></body>"), "");
});

test("a summary keeps only short, clean points whose numbers the story states", () => {
  const material = { title: "KKR to buy Acme for $2 billion", text: "KKR agreed to buy Acme for $2 billion. The deal values Acme at 12 times earnings.", basis: "article" as const };
  const s = validateSummary(
    {
      points: [
        "KKR agreed to buy Acme for $2 billion.",
        "The price is 12 times Acme's earnings — a full valuation.",
        "The deal is expected to close in 2027.", // 2027 is not in the text
        "word ".repeat(30).trim(), // too long
        "This shit deal is a big one.", // profanity
      ],
      takeaway: "Large buyouts are back, which means more deal work for junior bankers.",
    },
    material,
  );
  assert.deepEqual(s, {
    points: ["KKR agreed to buy Acme for $2 billion.", "The price is 12 times Acme's earnings, a full valuation."],
    takeaway: "Large buyouts are back, which means more deal work for junior bankers.",
    basis: "article",
  });
  assert.equal(validateSummary({ points: ["It closes in 2029."], takeaway: "x" }, material), null, "nothing survives, so no summary");
  assert.equal(validateSummary({ points: ["KKR is buying Acme."], takeaway: "Rates will fall 50 basis points." }, material)?.takeaway, null, "an ungrounded takeaway is dropped, the points stay");
});

import { pageDescription } from "../../src/lib/news/page-image";

test("a paywalled page still gives up the publisher's own description of the story", () => {
  const html = `<html><head><meta name="description" content="Short.">
    <meta property="og:description" content="Goldman Sachs&#39; board has discussed naming John Waldron chief executive as soon as next year, people familiar said.">
  </head><body><p>Subscribe to read</p></body></html>`;
  assert.equal(pageDescription(html), "Goldman Sachs' board has discussed naming John Waldron chief executive as soon as next year, people familiar said.");
  assert.equal(pageDescription("<head><meta name='description' content='Home page'></head>"), null, "a few words is not a description");
});

test("a point that leans on the one before it, or cites its own source, is dropped", () => {
  const material = { title: "Jana pushes Fiserv on costs", text: "Jana Partners wants Fiserv to double cost savings and use Palantir.", basis: "feed" as const };
  const s = validateSummary(
    {
      points: ["Jana Partners wants Fiserv to double its planned cost savings.", "It also wants Fiserv to use Palantir.", "The deal is backed by Jana.", "According to the summary, Jana wrote a letter."],
      takeaway: "Jana is pressing Fiserv for deeper cost cuts.",
    },
    material,
  );
  assert.deepEqual(s?.points, ["Jana Partners wants Fiserv to double its planned cost savings."]);
});


test("a market bullet in the briefing may cite the day's numbers instead of a story, and states only those numbers", () => {
  const data = new Map([["d1", "10-year Treasury yield: 5.26%, up 2 basis points, on 2026-09-29, source US Treasury"]]);
  const b = validateBullet({ text: "The 10-year Treasury yield closed at 5.26% on Tuesday, up 2 basis points.", stories: [], data: ["d1"] }, new Map(), data);
  assert.deepEqual(b, { text: "The 10-year Treasury yield closed at 5.26% on Tuesday, up 2 basis points.", sources: [], data: ["US Treasury"] });
  assert.equal(validateBullet({ text: "The 10-year yield closed at 5.3%.", stories: [], data: ["d1"] }, new Map(), data), null, "5.3 is not the published number");
  assert.equal(validateBullet({ text: "Yields rose.", stories: [], data: ["d9"] }, new Map(), data), null, "cites nothing that exists");
});

// ------------------------------------------------------------------ second security review (30 September 2026)

import { chartable } from "../../src/lib/market-data/board";

test("an internal address in any IPv6 spelling is refused, as is any port but the web's", async () => {
  // How new URL() hands these over: hex, not the dotted form an attacker typed.
  for (const ip of ["::ffff:7f00:1", "::7f00:1", "::ffff:c0a8:101", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::", "2002:c0a8:101::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.ok(isPublicAddress("64:ff9b::808:808"), "NAT64 of a public address is public");
  for (const url of ["http://[::ffff:127.0.0.1]:3001/", "http://[::ffff:7f00:1]/", "http://[::127.0.0.1]/", "http://[64:ff9b::7f00:1]/", "http://8.8.8.8:22/", "http://8.8.8.8:6379/"]) {
    await assert.rejects(assertPublicUrl(url), UnsafeUrlError, url);
  }
  assert.equal((await assertPublicUrl("https://8.8.8.8:8443/x")).port, "8443");
});

test("the market history route charts only its own list - not whatever an object happens to inherit", () => {
  for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) assert.equal(chartable(id), false, id);
  assert.ok(chartable("DCOILWTICO"));
});

test("a summary point carrying a link or an email address is dropped", () => {
  const material = { title: "Acme raises $5 million", text: "Acme raised $5 million. Apply at www.acme.example or write to jobs@acme.example.", basis: "article" as const };
  const s = validateSummary({ points: ["Acme raised $5 million.", "Students can apply at www.acme.example.", "Write to jobs@acme.example for details.", "See https://acme.example/jobs."], takeaway: "Acme is hiring." }, material);
  assert.deepEqual(s?.points, ["Acme raised $5 million."]);
});

/**
 * CPU time, not wall clock.
 *
 * These three functions are pure and synchronous, so the work they do is
 * their own CPU time. Wall clock also counts every other process competing
 * for a core, which is why the wall-clock version of this test was a
 * recurring false alarm: measured on 11 October 2026 the three calls cost
 * 2.3 seconds of CPU and 3.2 seconds of wall clock on an idle machine, and
 * the same calls reported `took 185364ms` during a full `npm test` run - 58x
 * inflation, against a 20-second bound, with nothing wrong with the code.
 * Run alone the file passed 79 of 79.
 *
 * A bound that fails when the machine is busy teaches people to ignore it,
 * which costs more than the bug it was guarding against.
 */
function cpuMsOf(work: () => void): number {
  const before = process.cpuUsage();
  work();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / 1000;
}

/** The three inputs built to make an unbounded regex backtrack. */
function stallingInputs() {
  return {
    text: "<article>" + "<p ".repeat(200_000),
    images: "<" + "a".repeat(2_500_000),
    head: "<head>" + "<meta ".repeat(200_000),
  };
}

function readAll(input: ReturnType<typeof stallingInputs>): void {
  articleText(input.text);
  articleImages(input.images, "https://example.com");
  pageDescription(input.head);
}

test("a page built to stall the text reader is read in seconds, not hours", () => {
  // 2.3s measured; 20s is an order of magnitude of headroom for a slower
  // machine while still catching the failure this guards: removing one of the
  // bounds in page-image.ts makes these inputs backtrack quadratically over
  // hundreds of thousands of characters, which is minutes of CPU, not seconds.
  const cpuMs = cpuMsOf(() => readAll(stallingInputs()));
  assert.ok(cpuMs < 20_000, `spent ${Math.round(cpuMs)}ms of CPU`);
});

/**
 * WHY THERE IS NO SECOND, SIZE-BASED ASSERTION HERE.
 *
 * An obvious companion is "doubling the hostile input must not double the
 * cost", on the reasoning that page-image.ts truncates (`SCAN_LIMIT`,
 * `slice(start, start + 400_000)`). It was written, and it does not work:
 * with the truncation deleted - either the 400,000 slice in `articleText` or
 * `SCAN_LIMIT` in `scan()` - it still passed. Doubling these particular
 * inputs does not change the cost either way, because the counted quantifiers
 * are what bound the scan, and `MAX_TEXT` stops the match loop regardless.
 *
 * So it asserted nothing it claimed to, and an assertion that survives the
 * removal of what it checks is worse than none: it reads as cover. Removed
 * rather than kept. If the truncation limits are worth a guard of their own,
 * it needs an input shaped to make them bind - complete `<p>...</p>` pairs
 * past the 400,000 boundary - not a longer run of the same junk.
 */

