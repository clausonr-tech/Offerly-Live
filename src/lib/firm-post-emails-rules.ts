// The email a student gets when a firm they match with posts. Pure, so the
// wording is tested (scripts/test/firm-post-emails.test.ts). Plain text: it
// has to read well in every mail client, and carries the firm's own words,
// which must never be rendered as HTML.

export type FirmPostEmailInput = {
  kind: "internship" | "event";
  firmName: string;
  title: string;
  /** "Speaker event", "Info session"... for events. */
  eventKind?: string;
  when: Date | null;
  place: string | null;
  school: string | null;
  studentName: string | null;
  link: string | null;
  settingsLink: string | null;
};

const one = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function firmPostEmail(p: FirmPostEmailInput): { subject: string; text: string } {
  const firm = one(p.firmName);
  const title = one(p.title);
  const first = (p.studentName ?? "").trim().split(/\s+/)[0];
  const date = p.when?.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

  const subject =
    p.kind === "internship"
      ? `${firm} posted a new internship: ${title}`
      : `${firm}: ${(p.eventKind ?? "event").toLowerCase()}${p.school ? " at your school" : ""}${date ? ` on ${date}` : ""}`;

  const lines = [
    first ? `Hi ${first},` : "Hi,",
    "",
    p.kind === "internship"
      ? `${firm}, one of the firms you're matched with on Offerly, just posted an internship:`
      : `${firm}, one of the firms you're matched with on Offerly, is holding an event:`,
    "",
    `  ${title}`,
    ...(p.kind === "internship" && date ? [`  Apply by ${date}`] : []),
    ...(p.kind === "event" && date ? [`  ${date}`] : []),
    ...(p.place ? [`  ${one(p.place)}`] : []),
    "",
    p.link ? `See it on Offerly: ${p.link}` : "Open Offerly to see it.",
    "",
    "You're getting this because you're matched with this firm.",
    p.settingsLink ? `Turn these emails off: ${p.settingsLink}` : "You can turn these emails off in Offerly under Profile > Connections.",
  ];
  return { subject: subject.slice(0, 200), text: lines.join("\n") };
}
