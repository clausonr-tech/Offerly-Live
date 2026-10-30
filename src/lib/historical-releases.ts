// When internships were released in past cycles, as uploaded - the strongest
// source for an expected role's dates (lib/expected-postings). Written only by
// scripts/import-historical-releases.ts from a CSV; never edit the JSON by hand.

import type { HistoricalRelease } from "./expected-postings";
import rows from "./historical-releases.json";

export const HISTORICAL_RELEASES: readonly HistoricalRelease[] = rows as HistoricalRelease[];
