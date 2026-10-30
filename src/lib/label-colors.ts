// One colour per kind of job, everywhere a job is labelled: the to-do chips
// (THANK, SEND, NETWORK...), the bell, and the banner that drops in when a
// prompt fires. Before this, five kinds shared gold and two shared red, so a
// glance could not tell a thank-you from a follow-up.
//
// Literal hex rather than theme tokens: every place these appear is a panel
// that stays white in both themes (.list-panel, the banner), and the dark
// theme re-skins the tokens (accent-500 becomes white). Client-safe, no
// imports.

export type LabelTone =
  | "deadline"
  | "event"
  | "follow_up"
  | "draft"
  | "coverage"
  | "outreach"
  | "interview"
  | "thank_you"
  | "apply"
  | "posting";

/** fg: text and edges. bg: a chip's fill. tint: a whole banner's fill. */
export const LABEL_TONES: Record<LabelTone, { fg: string; bg: string; tint: string }> = {
  deadline: { fg: "#a1261b", bg: "#fdecea", tint: "#f8dcd8" },
  follow_up: { fg: "#9a4d0b", bg: "#fdeedd", tint: "#f7e0c6" },
  thank_you: { fg: "#7a5b00", bg: "#fbf3d6", tint: "#f3e7b9" },
  apply: { fg: "#1e6b3a", bg: "#e3f3e8", tint: "#d2e9da" },
  event: { fg: "#1f6b78", bg: "#e0f2f4", tint: "#cfe8ec" },
  posting: { fg: "#0b6a93", bg: "#e1f2fa", tint: "#cfe7f3" },
  draft: { fg: "#24447a", bg: "#e6ecf8", tint: "#dbe2ed" },
  outreach: { fg: "#5b44a8", bg: "#efeafb", tint: "#e1d9f5" },
  interview: { fg: "#9b2c5e", bg: "#fbe7f0", tint: "#f3d6e3" },
  coverage: { fg: "#475467", bg: "#eceff3", tint: "#e0e4ea" },
};

/** The tone of a job under the bell, by its notification kind. */
export function toneForNotification(kind: string | null | undefined): LabelTone {
  switch (kind) {
    case "interview_prep":
      return "interview";
    case "follow_up":
      return "follow_up";
    case "thank_you":
      return "thank_you";
    case "application_deadline":
      return "apply";
    case "firm_posting":
      return "posting";
    case "firm_event":
      return "event";
    default:
      return "outreach";
  }
}

/**
 * A firm's recruiting events, one colour per kind - the NETWORKING and INFO
 * SESSION tags on a firm's page. The same palette, so the whole platform
 * speaks one set of colours; "other" stays neutral because it is the
 * parser's not-guessed bucket.
 */
export const EVENT_KIND_TONES: Record<string, LabelTone> = {
  info_session: "posting",
  coffee_chat: "follow_up",
  networking: "outreach",
  insight_day: "apply",
  speaker_event: "interview",
  other: "coverage",
};
