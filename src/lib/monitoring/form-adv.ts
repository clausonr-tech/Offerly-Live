import "server-only";
import { readFileSync } from "fs";
import path from "path";

import {
  domainOf,
  indexByDomain,
  sizeIn,
  type AdvFile,
  type FirmSize,
} from "./form-adv-parse";

/**
 * Firm size, from the SEC's own filings.
 *
 * `enrollment.ts` has always asked for `employees` and always been handed
 * null, which is why its rejections said "no Form ADV size data to judge by"
 * rather than "too small". This is the data that answers it: Item 5A total
 * employees and Item 5F regulatory assets under management, for 23,918
 * SEC-registered advisers and exempt reporting advisers.
 *
 * Built by scripts/ingest-form-adv.ts, which matched 10,216 of the 22,575
 * directory rows - 45%, and concentrated exactly where it should be:
 *
 *   venture capital        61%      commercial banking      3%
 *   private equity         55%      investment banking      2%
 *   hedge funds            55%
 *   real estate           54%
 *
 * Those last two low numbers are not a gap in the data, they are the data
 * being honest: banks and broker-dealers file with FINRA, not as investment
 * advisers, so they are absent from this feed by definition. A firm missing
 * here is "not an SEC-registered adviser", never "small".
 *
 * MATCHED BY DOMAIN
 * -----------------
 * Never by name. Both this feed and the directory carry legal entity names -
 * "Blackstone Isg-i Advisors L.L.C." - and they disagree on punctuation,
 * suffix and which affiliate filed. A domain is exact.
 */

/**
 * The parser, the normaliser and the index live in ./form-adv-parse, which is
 * pure and has committed fixtures. This file is only the part that cannot be:
 * reading one specific optional file off disk and caching it.
 */
export { domainOf, type FirmSize };

const DATA_PATH = path.join(process.cwd(), "scripts", "data", "form-adv-firms.json");

let byDomain: Map<string, FirmSize> | null = null;
let loadFailure: string | null = null;

function load(): Map<string, FirmSize> {
  if (byDomain) return byDomain;
  try {
    const parsed = JSON.parse(readFileSync(DATA_PATH, "utf8")) as AdvFile;
    byDomain = indexByDomain(parsed.firms ?? []).index;
  } catch (error) {
    /**
     * A missing file is not an error worth crashing a crawl over.
     *
     * Enrollment already treats null size as "unknown, and here is why" - so
     * the system degrades to exactly the behaviour it had before this data
     * existed. The failure is recorded so `formAdvStatus()` can report it
     * rather than leaving a silent zero, which is the failure mode this
     * codebase keeps paying for.
     */
    loadFailure = error instanceof Error ? error.message : String(error);
    byDomain = new Map();
  }
  return byDomain;
}

/** Size for a firm's website, or null when it does not file with the SEC as
 *  an investment adviser. Null means unknown, never small. */
export function sizeForWebsite(website: string | null | undefined): FirmSize | null {
  return sizeIn(load(), website);
}

/** Whether the dataset loaded, and how big it is - for scripts that should
 *  say so rather than quietly size nothing. */
export function formAdvStatus(): { loaded: boolean; firms: number; error: string | null } {
  const map = load();
  return { loaded: map.size > 0, firms: map.size, error: loadFailure };
}

/** Whether the optional extract is on disk at all. Separated from
 *  `formAdvStatus` so a caller can distinguish "never ingested" from "ingested
 *  and unreadable" without parsing an error string. */
export function formAdvFilePresent(): boolean {
  try {
    readFileSync(DATA_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
