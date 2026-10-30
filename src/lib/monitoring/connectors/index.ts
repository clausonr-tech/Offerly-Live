import "server-only";
import type { SourceConnector, SourceRef } from "./types";
import { greenhouseConnector } from "./greenhouse";
import { genericConnector, closeGenericConnectorBrowser } from "./generic";
import { talentLinkConnector } from "./talentlink";
import { workdayConnector } from "./workday";
import { oracleHcmConnector } from "./oracle-hcm";
import { leverConnector } from "./lever";
import { icimsConnector } from "./icims";
import { goldmanConnector } from "./goldman";
import { eightfoldConnector } from "./eightfold";
import { krollConnector } from "./kroll";
import { ashbyConnector } from "./ashby";
import { smartRecruitersConnector } from "./smartrecruiters";
import { workableConnector } from "./workable";
import { getroConnector } from "./getro";
import { breezyConnector } from "./breezy";
import { recruiteeConnector } from "./recruitee";
import { dayforceConnector } from "./dayforce";
import { bambooHrConnector } from "./bamboohr";
import { jobviteConnector } from "./jobvite";
import { bairdConnector } from "./baird";

export type { NormalizedListing, ConnectorFetchResult, SourceConnector, SourceRef } from "./types";
export { closeGenericConnectorBrowser };

// Order matters: the first connector that canHandle()s a source wins, and
// genericConnector matches everything, so it has to be last.
const CONNECTORS: SourceConnector[] = [
  greenhouseConnector,
  talentLinkConnector,
  workdayConnector,
  oracleHcmConnector,
  leverConnector,
  icimsConnector,
  goldmanConnector,
  eightfoldConnector,
  krollConnector,
  // Mid-market platforms. Added 19 Sep for the directory beyond investment
  // banking - IB is 888 of 22,569 firms and its bulge brackets are all on
  // Workday or TalentLink, while venture capital, growth equity and fintech
  // sit on these three. Each endpoint was verified responding before the
  // connector was written.
  ashbyConnector,
  smartRecruitersConnector,
  workableConnector,
  // Portfolio boards. The only connector where one fetch covers many firms -
  // a fund's whole portfolio rather than one employer - which is the only
  // shape that reaches 2,149 venture capital firms, of which 1,863 have a
  // website and none has a careers URL. Endpoint verified responding 19 Sep
  // before the file was written; the previous session correctly refused to
  // write it without a real board URL to read a collection id from.
  getroConnector,
  // Verified by the six-control probe check on 19 Sep. No firm in the
  // directory is known to run Breezy yet - this exists so a probe HIT is
  // readable, because a found board with no connector becomes a Chromium
  // launch per check against a page whose JSON is one request away.
  breezyConnector,
  recruiteeConnector,
  /**
   * Platforms that blocked real estate coverage, added 19 Sep.
   *
   * Board discovery found 8 RE firms on platforms with no connector, so each
   * registered against genericConnector and launched Chromium every check to
   * scrape a page whose data is one request away. Three of those firms are on
   * UltiPro and stay unreachable: its robots.txt disallows the JobBoardView
   * path, the only endpoint that enumerates a board, and re-checking it on
   * 19 Sep found the rule unchanged since the 18 Sep decision. The other five
   * are here.
   *
   * bairdConnector is the same shape of fix for a different problem - see its
   * file header on why a 403 turned out not to be a refusal.
   */
  dayforceConnector,
  bambooHrConnector,
  jobviteConnector,
  bairdConnector,
  genericConnector,
];

export function getConnector(connectorId: string): SourceConnector {
  const connector = CONNECTORS.find((c) => c.id === connectorId);
  if (!connector) throw new Error(`No connector registered for id "${connectorId}"`);
  return connector;
}

/** Picks the best connector for a URL when a source is first registered -
 *  used by the seed script, not by the scheduler (which trusts the stored
 *  connectorId so a source can be manually reassigned without re-detection). */
export function detectConnector(careersUrl: string): SourceConnector {
  const source: SourceRef = { careersUrl, sourceType: "", lastEtag: null };
  return CONNECTORS.find((c) => c.canHandle(source)) ?? genericConnector;
}
