// The reasons a student can give for reporting a story. Fixed choices, so the
// Report link takes no typed words. Shared by the card's menu and the server.

export const REPORT_REASONS = {
  not_finance: "Not finance news",
  wrong: "Wrong or misleading",
  wrong_sector: "In the wrong section",
  offensive: "Offensive",
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === "string" && Object.hasOwn(REPORT_REASONS, value);
}
