import Link from "next/link";

// The Schedule page is where a student notices their calendar is empty, so the
// invitation to connect belongs here rather than only in Settings.
//
// It has moved twice. It was once a full-width card with an icon, a heading and
// a paragraph explaining the one-way sync - a paragraph answering a question
// nobody had asked yet, sitting above the calendar on every visit for the whole
// life of the account to explain a button. Then it was one line of text under
// the title. It now lives *inside* the blue header card, in the slot Download
// .ics used to occupy, because connecting is the thing a student actually needs
// from this page and an export link was taking the only prominent action slot.
//
// Colours here are literal hex, not `text-white`: the dark theme redefines
// --color-white to near-black, which would invert this against a card whose
// blue never changes.
//
// Still three states, because "nothing happens when I click connect" is the
// worst of them: a deployment with no Google OAuth client says so plainly
// instead of rendering a link that dead-ends.
export default function GoogleConnectBanner({
  configured,
  connectedEmails,
}: {
  configured: boolean;
  connectedEmails: (string | null)[];
}) {
  if (!configured) {
    return (
      <p
        className="shrink-0 text-sm text-[#ffffff]/70"
        // The setup detail is a deployment concern, not a student's - kept on
        // hover so whoever runs the environment can still find it.
        title="No Google OAuth client for this deployment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET - steps are in .env.example."
      >
        Google Calendar not set up here
      </p>
    );
  }

  if (connectedEmails.length === 0) {
    // A plain link, not a form: the OAuth start route is a GET redirect.
    // Same ghost-button treatment the .ics link had, and that Import CSV has
    // on Opportunities.
    return (
      <a
        href="/api/auth/google/start"
        className="ui-round-md flex shrink-0 items-center gap-1.5 border border-[#ffffff]/30 px-4 py-2 text-sm font-medium text-[#ffffff] transition-colors hover:bg-[#ffffff]/10"
      >
        Connect Google Calendar +
      </a>
    );
  }

  const label = connectedEmails.filter(Boolean).join(", ");

  // Connected is a status, not an action, so it is not dressed as a button -
  // only Manage is clickable. A ghost button reading "Connected" invites a
  // click that would do nothing.
  return (
    <p className="shrink-0 text-sm text-[#ffffff]/80">
      Google Calendar connected{label && ` (${label})`}{" "}
      <Link href="/profile/connections" className="font-medium text-[#ffffff] underline-offset-2 hover:underline">
        Manage
      </Link>
    </p>
  );
}
