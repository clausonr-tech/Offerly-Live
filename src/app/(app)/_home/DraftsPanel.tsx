import Link from "next/link";
import { Mrs_Saint_Delafield } from "next/font/google";
import { format } from "date-fns";
import OpenTag from "./OpenTag";

// A real signature face, not the generic "cursive" font-family keyword -
// that keyword resolves to wildly different (and often not-actually-script)
// fonts across platforms. Loaded here rather than in the app layout: this is
// the only place in the app anything is signed, so the font has no business
// being part of the global bundle.
const signature = Mrs_Saint_Delafield({ subsets: ["latin"], weight: "400" });

export type StackDraft = {
  id: string;
  subject: string;
  body: string;
  kind: "cold_outreach" | "follow_up" | "thank_you" | "custom";
  createdAt: string;
  contactName: string | null;
};

const KIND_LABEL: Record<StackDraft["kind"], string> = {
  cold_outreach: "Cold outreach",
  custom: "Custom",
  follow_up: "Follow-up",
  thank_you: "Thank-you",
};

// Shown until the student has generated a first draft of their own - the same
// reasoning as Applications' SAMPLE: a panel that only ever looks like
// something once it already has data teaches nobody what the section is for.
// PLACEHOLDER IN THE UI ONLY, never a row in `email_drafts` - the moment a
// real draft exists for this account it replaces this one in the query, not
// in code. Signed with the account's own real name, so it previews exactly
// what THEIR draft will look like rather than someone else's.
const SAMPLE_BODY =
  "I'm a student recruiting for investment banking, and I came across your profile at Goldman Sachs. I'd love the chance to hear more about your path there and how you approached recruiting.\n\nWould you have 15-20 minutes sometime in the next couple of weeks for a quick call, whenever works with your schedule?";

function sample(): StackDraft {
  return {
    id: "sample-coffee-chat",
    subject: "Quick coffee chat about Goldman Sachs?",
    body: SAMPLE_BODY,
    kind: "cold_outreach",
    createdAt: "2026-08-20T00:00:00.000Z",
    contactName: "John Doe",
  };
}

// The last panel in the set, and the one built from correspondence rather
// than records. Every other panel here shows what something IS - a firm, a
// contact, a status - at a glance. A draft is different: the point of it is
// the writing itself, so this is the one panel that reads like the real
// artifact instead of standing in for it. A single open letter, not a stack
// of closed ones - subject, the opening of the body, and the sign-off, the
// way an email actually looks the moment before you hit send.
const LETTER_H = 270;

export default function DraftsPanel({
  drafts,
  userName,
}: {
  drafts: StackDraft[];
  userName: string;
}) {
  const isSample = drafts.length === 0;
  const draft = isSample ? sample() : drafts[0];

  return (
    <section id="drafts" className="relative mb-16 scroll-mt-6">
      <Link
        href="/outreach"
        aria-label="Open Outreach"
        className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <div className="feed-divider relative overflow-hidden border-t bg-surface-1">
          {/* Fades the panel's own lighter surface into the darker page
              background at its left and right edges. */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />

          {/* Split 25/77 rather than the family's usual flush-top + pb-24:
              the letter is one fixed-height card, not a pile or a stack, so
              sitting flush against the hairline read as pinned to the wrong
              edge. This centers it in the gap between the hairline above and
              the "Drafts" title below - same reasoning as News's own spacing
              fix, just solved for a single card's height instead of a strip
              of tiles. */}
          <div className="px-5" style={{ paddingTop: 25, paddingBottom: 77 }}>
            {/* Hidden from assistive tech when this is the sample letter: it
                demonstrates the format, it is not a draft the student wrote. */}
            {isSample && (
              <p className="sr-only">
                No drafts yet. The letter shown is an example of how a draft appears once you
                generate one.
              </p>
            )}
            <div
              aria-hidden={isSample || undefined}
              className="doc-sheet mx-auto flex max-w-md flex-col overflow-hidden border p-6 shadow-card"
              style={{ height: LETTER_H }}
            >
              <p className="doc-label font-mono text-[10px] uppercase tracking-[0.16em]">
                To {draft.contactName ?? "Not yet addressed"} · {KIND_LABEL[draft.kind]} ·{" "}
                {format(new Date(draft.createdAt), "d MMM")}
              </p>

              <h3 className="display-serif mt-2 text-lg font-bold leading-snug">
                {draft.subject}
              </h3>

              <div className="doc-rule mt-3" />

              <p className="mt-3 line-clamp-4 whitespace-pre-line text-[13px] leading-relaxed opacity-90">
                {draft.body}
              </p>

              {/* The sign-off. Right-aligned like a real letter's closing, and
                  pinned to the bottom of the card regardless of how long the
                  body preview above runs. */}
              <p
                className={`${signature.className} mt-auto self-end text-3xl leading-none`}
                style={{ opacity: 0.92 }}
              >
                {userName}
              </p>
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-surface-1 via-surface-1/85 to-transparent" />
          {/* This is the last panel in the stack - nothing but page
              background sits below it (the mb-16 gap, then the footer) - so
              unlike its neighbours, its own bottom edge fades one step
              further, into that background, rather than staying solid
              surface-1 all the way down. Sits above the scrim (same z-10,
              later in source order) but below the title (z-20), so the
              title keeps its own solid backdrop regardless. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-background to-transparent" />

          <div className="pointer-events-none absolute bottom-6 left-0 z-20 flex items-end gap-4">
            <h2 className="ml-[0.02em] text-[8vw] font-bold italic leading-[0.85] tracking-tight text-brand-900 sm:text-4xl lg:text-5xl">
              Drafts
            </h2>
            <OpenTag />
          </div>
        </div>
      </Link>
    </section>
  );
}
