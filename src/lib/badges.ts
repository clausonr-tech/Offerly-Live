export const RELATIONSHIP_LABELS: Record<string, string> = {
  not_contacted: "Not contacted",
  reached_out: "Reached out",
  in_conversation: "In conversation",
  ongoing: "Ongoing",
  cold: "Cold",
};

// Tinted outline tags: a soft wash of the hue, a slightly stronger border, and
// the hue itself as the text. Reads as an institutional status marker rather
// than a bright filled pill.
//
// Built on the signal-* scale rather than raw Tailwind palette colours, which
// matters more than it looks: the raw scales are fixed values, so `bg-slate-50`
// stayed near-white under the terminal theme and these pills glared against the
// black canvas. Every signal token is redefined per theme, so the same class
// resolves correctly in both.
//
// The hues are ordered to track progress rather than being arbitrary - neutral
// before you start, cyan once moving, violet in flight, amber when it's live,
// green for a win, red for a loss - so a column of them is scannable.
//
// Written out in full rather than composed from a helper: Tailwind scans source
// text for class names, so an interpolated `border-${hue}/35` is never emitted
// and the pill silently loses its styling.

export const RELATIONSHIP_COLORS: Record<string, string> = {
  not_contacted: "border border-brand-200 bg-brand-50 text-warmgray-500",
  reached_out: "border border-signal-cyan/35 bg-signal-cyan/10 text-signal-cyan",
  in_conversation: "border border-signal-violet/35 bg-signal-violet/10 text-signal-violet",
  ongoing: "border border-signal-lime/35 bg-signal-lime/10 text-signal-lime",
  cold: "border border-brand-100 bg-transparent text-warmgray-500",
};

export const APPLICATION_STATUS_LABELS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
};

export const APPLICATION_CATEGORY_LABELS: Record<string, string> = {
  investment_banking: "Investment Banking",
  private_equity: "Private Equity",
  real_estate: "Real Estate",
  hedge_fund: "Hedge Fund",
  asset_management: "Asset Management",
  corporate_finance: "Corporate Finance",
  consulting: "Consulting",
  other: "Other",
};
