/**
 * Part of every crest URL. /api/crest answers are cached for 30 days as
 * immutable, so when what a school's crest points at changes (the switch to
 * schools.crest_url - see scripts/find-school-crests.ts; or a firm's entry in
 * firm-logos.json - see scripts/find-firm-logos.ts), bump this and
 * browsers fetch the new image instead of keeping the old one.
 */
export const CREST_VERSION = 7;
