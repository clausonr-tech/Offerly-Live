// Reading a TalentLink board that publishes no Atom feed.
//
// The connector had exactly one way in - find the feed link, parse <entry>
// elements - and treated its absence as proof that the URL was not a job
// board. Morgan Stanley is a board with no feed: 154KB of server-rendered
// HTML, 125 live vacancies, every feed path a 404. So the source reported a
// clean 200 with zero listings and the firm read as having no openings, for as
// long as it was monitored. Nothing errored, so nothing was noticed.
//
// Fixtures are cut from the real board, measured 19 September 2026.

import { test } from "node:test";
import assert from "node:assert/strict";
import { boardRows, readBoardPages } from "../../src/lib/monitoring/connectors/talentlink";

const BOARD_URL = "https://morganstanley.tal.net/candidate/jobboard/vacancy/1/adv/";

/** A board page, with the Title / City columns the real one has. */
function board(rows: string, headers = ["Title", "City"]): string {
  return `<table><thead><tr>${headers
    .map((h) => `<th class="comm_list_thead">${h}</th>`)
    .join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function row(oppid: string, title: string, cells: string[]): string {
  return (
    `<tr class="opp_${oppid} search_res details_row" data-oppid="${oppid}" data-title="${title}">` +
    `<td class="comm_list_tbody"><a class="subject" href="https://morganstanley.tal.net/vx/lang-en-GB/mobile-0/brand-2/xf-06815048588f/candidate/so/pm/1/pl/1/opp/${oppid}-slug/en-GB">\n  ${title}  </a></td>` +
    cells.map((c) => `<td class="comm_list_tbody">\n  ${c}   </td>`).join("") +
    `</tr>`
  );
}

const REAL = board(
  row("22202", "2026 Human Resources Off Cycle Internship (Milan)", ["Milan"]) +
    row("22069", "2027 Investment Banking Industrial Placement Program (Taipei)", ["Taipei"]) +
    row("21960", "2027 Institutional Equity Derivatives Trading Co-Op", ["New York"]),
);

// --------------------------------------------------------------- the rows

test("every vacancy row is read", () => {
  assert.equal(boardRows(REAL).length, 3);
});

test("the external id is the source's own, not a synthesised hash", () => {
  // A listing without a real id fails `verifiable` and can never be
  // auto-approved - which is the whole reason this is not left to the
  // generic connector.
  assert.deepEqual(
    boardRows(REAL).map((r) => r.oppid),
    ["22202", "22069", "21960"],
  );
});

test("the title comes from data-title, not from the link's whitespace", () => {
  assert.equal(boardRows(REAL)[0].title, "2026 Human Resources Off Cycle Internship (Milan)");
});

test("the anchor text is the fallback when data-title is absent", () => {
  const html = board(
    `<tr data-oppid="99"><td><a class="subject" href="/candidate/so/opp/99-x/en-GB">\n  Summer Analyst Programme  \n</a></td><td>London</td></tr>`,
  );
  assert.equal(boardRows(html)[0].title, "Summer Analyst Programme");
});

test("a row with no title at all is skipped rather than stored blank", () => {
  const html = board(`<tr data-oppid="100"><td><a class="subject" href="/x"></a></td><td>London</td></tr>`);
  assert.equal(boardRows(html).length, 0);
});

test("entities in the title are decoded", () => {
  const html = board(row("7", "Mergers &amp; Acquisitions Internship", ["Paris"]));
  assert.equal(boardRows(html)[0].title, "Mergers & Acquisitions Internship");
});

// ----------------------------------------------------------- the location

test("the location is read from the column the header names", () => {
  assert.deepEqual(
    boardRows(REAL).map((r) => r.location),
    ["Milan", "Taipei", "New York"],
  );
});

test("a board that orders its columns differently still reads the city", () => {
  // THE reason the header is parsed instead of taking "the second cell".
  // Position is not a constant across tenants, and a department filed as a
  // location is a wrong answer that looks like a right one.
  const html = board(
    `<tr data-oppid="5" data-title="Summer Analyst"><td><a href="/x">Summer Analyst</a></td><td>Investment Banking</td><td>Frankfurt</td></tr>`,
    ["Title", "Department", "City"],
  );
  assert.equal(boardRows(html)[0].location, "Frankfurt");
});

test("a board with no location column leaves it null rather than guessing", () => {
  const html = board(
    `<tr data-oppid="6" data-title="Summer Analyst"><td><a href="/x">Summer Analyst</a></td><td>Investment Banking</td></tr>`,
    ["Title", "Department"],
  );
  assert.equal(boardRows(html)[0].location, null);
});

test("no header at all is not an error", () => {
  const html = `<table><tbody>${row("8", "Off-Cycle Internship", ["Milan"])}</tbody></table>`;
  assert.equal(boardRows(html).length, 1);
  assert.equal(boardRows(html)[0].location, null);
});

// ------------------------------------------------------------- robustness

test("a page with no vacancy rows yields nothing", () => {
  for (const html of ["", "<html><body>Sorry, no results.</body></html>", board("")]) {
    assert.equal(boardRows(html).length, 0);
  }
});

test("boardRows never throws", () => {
  for (const html of ["", "<tr data-oppid=", "<tr data-oppid=\"1\">", "x".repeat(20000)]) {
    assert.doesNotThrow(() => boardRows(html));
  }
});

// --------------------------------------------------------------- paging

/** A fake board serving `pages` in order, keyed by the `start` parameter. */
function pager(pages: string[]) {
  const calls: string[] = [];
  return {
    calls,
    fetchPage: async (url: string) => {
      calls.push(url);
      const start = Number(new URL(url).searchParams.get("start") ?? 0);
      const page = pages[start / 50];
      return page === undefined ? { body: board(""), status: 200 } : { body: page, status: 200 };
    },
  };
}

const fifty = (from: number) =>
  board(
    Array.from({ length: 50 }, (_, i) => row(String(from + i), `Vacancy ${from + i}`, ["London"])).join(""),
  );

test("paging continues while the board offers new vacancies", async () => {
  // Morgan Stanley, measured: 50, 50, 25, then nothing -> 125 distinct.
  const last = board(
    Array.from({ length: 25 }, (_, i) => row(String(200 + i), `Vacancy ${200 + i}`, ["London"])).join(""),
  );
  const p = pager([fifty(0), fifty(100), last]);
  const out = await readBoardPages(BOARD_URL, fifty(0), p.fetchPage);
  assert.equal(out.listings.length, 125);
  assert.equal(out.truncated, false);
});

test("a board that ignores `start` terminates instead of looping", async () => {
  // Without this the loop would refetch page one until the page cap - a
  // hundred requests for fifty vacancies. Termination is on NEW rows, not on
  // row count, precisely so this ends after one extra request.
  const p = pager([]);
  const same = fifty(0);
  const out = await readBoardPages(BOARD_URL, same, async () => ({ body: same, status: 200 }));
  assert.equal(out.listings.length, 50);
  assert.equal(out.truncated, false);
  assert.equal(out.pagesRead, 2, "should stop as soon as a page adds nothing");
  assert.equal(p.calls.length, 0);
});

test("a first page with nothing on it asks for no more", async () => {
  let called = 0;
  const out = await readBoardPages(BOARD_URL, board(""), async () => {
    called += 1;
    return { body: board(""), status: 200 };
  });
  assert.equal(out.listings.length, 0);
  assert.equal(called, 0, "a non-board page must not be paged through");
});

test("a failed page is reported truncated, so the tail is not closed", async () => {
  // The important half. A page that 500s mid-walk means the rest is unread,
  // and an unread tail marked complete is a live internship closed as ended.
  const out = await readBoardPages(BOARD_URL, fifty(0), async () => ({ body: "", status: 503 }));
  assert.equal(out.listings.length, 50);
  assert.equal(out.truncated, true);
});

test("a page that never stops offering new rows stops at the cap, truncated", async () => {
  let n = 1000;
  const out = await readBoardPages(BOARD_URL, fifty(0), async () => {
    n += 50;
    return { body: fifty(n), status: 200 };
  });
  assert.equal(out.truncated, true, "hitting the page cap is not a complete read");
  assert.ok(out.pagesRead <= 100);
});

// ------------------------------------------------------------- the listing

test("each vacancy carries its own absolute URL", async () => {
  const out = await readBoardPages(BOARD_URL, REAL, async () => ({ body: board(""), status: 200 }));
  for (const l of out.listings) {
    assert.match(l.listingUrl, /^https:\/\/morganstanley\.tal\.net\/.*\/opp\/\d+-/);
    assert.equal(l.applicationUrl, l.listingUrl);
  }
});

test("a relative href is resolved against the board", async () => {
  const html = board(
    `<tr data-oppid="11" data-title="Summer Analyst"><td><a class="subject" href="/candidate/so/opp/11-x/en-GB">Summer Analyst</a></td><td>London</td></tr>`,
  );
  const out = await readBoardPages(BOARD_URL, html, async () => ({ body: board(""), status: 200 }));
  assert.equal(out.listings[0].listingUrl, "https://morganstanley.tal.net/candidate/so/opp/11-x/en-GB");
});

test("the same vacancy on two pages is stored once", async () => {
  // Boards reorder by recency between requests, so overlap is normal and
  // duplicate listings are not.
  const out = await readBoardPages(BOARD_URL, REAL, async () => ({ body: REAL, status: 200 }));
  assert.equal(out.listings.length, 3);
});

test("the description is left empty for enrich rather than filled with the title", async () => {
  // A board row has no description on it. Copying the title into the field
  // would make `isThinDescription` judge by the wrong string and could
  // suppress the detail fetch that gets the real posting - so the row says
  // nothing rather than something untrue.
  const out = await readBoardPages(BOARD_URL, REAL, async () => ({ body: board(""), status: 200 }));
  for (const l of out.listings) {
    assert.equal(l.descriptionRaw, "");
    assert.equal(l.publishedAt, null, "a board row carries no date; inventing one would be a wrong deadline");
  }
});
