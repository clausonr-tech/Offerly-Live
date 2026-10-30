"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { emailLabel, shouldRenderEmail } from "@/lib/contact-email-render";
import { externalHref } from "@/lib/safe-url";
import { UserPlus } from "lucide-react";

import { generateContactsAction, type GenerateContactsResult } from "./generateContactsAction";
import { DraftEmailButton } from "../../../drafts/QuickDraft";

/** Plain-English summary of what the resume yielded. */
function describeResume(read: {
  interests: string[];
  employers: string[];
  activities: string[];
  skills: string[];
}): string {
  const parts = [
    read.employers.length && `${read.employers.length} employer(s)`,
    read.activities.length && `${read.activities.length} club(s)`,
    read.interests.length && `${read.interests.length} interest(s)`,
    read.skills.length && `${read.skills.length} skill(s)`,
  ].filter((v): v is string => typeof v === "string");
  return parts.length ? parts.join(", ") : "nothing yet";
}

export default function GenerateContactsButton({
  firmId,
  firmName,
  contactsPerRun,
  credits,
  autoRun = false,
  onAutoRun,
}: {
  firmId: string;
  firmName: string;
  contactsPerRun: number;
  credits: { remaining: number; limit: number; unlimited: boolean };
  /** Start a search as soon as this mounts - for a "Generate" button that
   *  lives elsewhere (External Network's firm rows) and opens this panel to
   *  show the result. */
  autoRun?: boolean;
  /** Told once the auto-run has been sent, so the caller can stop asking
   *  for it - reopening the panel later must not search again. */
  onAutoRun?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<GenerateContactsResult | null>(null);

  // Optimistically reflects spend within the session. The server is still the
  // authority - it re-checks the allowance on every call.
  const [remaining, setRemaining] = useState(credits.remaining);
  const out = !credits.unlimited && remaining <= 0;

  // `generate` is one intent per student and firm: pressed again, it returns
  // the people that first press found, runs nothing and charges nothing.
  // `refresh` is the deliberate "different people" request - offered once a
  // generate has come back as the saved set, never sent silently.
  const run = (mode: "generate" | "refresh" = "generate") => {
    startTransition(async () => {
      const r = await generateContactsAction({ firmId, mode });
      setResult(r);
      if (r.ok && !r.credits.unlimited) setRemaining(r.credits.remaining);
    });
  };

  // A ref, not state, guards the auto-run: React's dev-mode double mount
  // keeps the ref, so the effect's second pass sees it set and sends nothing.
  // The server would answer a repeat with the saved set and no charge anyway,
  // but a second request is still a second request.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoRun || autoRan.current || out) return;
    autoRan.current = true;
    run();
    onAutoRun?.();
    // run is recreated every render and reads nothing that should re-fire this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, out]);

  return (
    <div className="rounded-lg border border-brand-100 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-brand-900">Find people at {firmName}</p>
          <p className="mt-0.5 text-xs text-warmgray-500">
            Uses your profile, resume and LinkedIn to look for {contactsPerRun} people worth
            reaching out to. Each search adds {contactsPerRun} contacts.
          </p>
        </div>

        <button
          type="button"
          onClick={() => run()}
          disabled={pending || out}
          className="flex shrink-0 items-center gap-1.5 bg-accent-500 px-4 py-2 text-xs font-semibold text-white shadow-card transition-colors hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <UserPlus size={13} />
          {pending ? "Searching..." : `Generate ${contactsPerRun} contacts`}
        </button>
      </div>

      <p className="mt-2 text-xs text-warmgray-500">
        {credits.unlimited ? (
          <span className="font-medium text-success-800">Unlimited searches on this account</span>
        ) : (
          <>
            <span className="font-medium text-brand-900">{remaining}</span> of {credits.limit}{" "}
            searches left this month
          </>
        )}
      </p>

      {result && !result.ok && <p className="mt-2 text-xs text-error-600">{result.error}</p>}

      {result?.ok && (
        <div className="mt-3 border-t border-brand-100 pt-3">
          {/* Says plainly that nothing was charged or saved. A button that
              looked like it worked but silently did nothing would be worse
              than no button at all. */}
          <p className="text-xs font-medium text-brand-900">
            {result.status === "sourced"
              ? `${result.contacts.length} saved to your contacts. ${result.totalMatching} people match this search.`
              : result.status === "cached"
                ? `These are the ${result.contacts.length} people you already found at ${firmName}. Nothing was used.`
                : result.status === "in_progress"
                  ? "Still searching from your last click - they will appear here in a moment."
                  : "Contact search is not connected yet - nothing was used or saved."}
          </p>
          {result.status === "cached" && (
            <button
              type="button"
              onClick={() => run("refresh")}
              disabled={pending || out}
              className="mt-2 flex items-center gap-1.5 border border-accent-500 px-3 py-1.5 text-xs font-semibold text-accent-700 transition-colors hover:bg-accent-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <UserPlus size={12} />
              {pending ? "Searching..." : `Find ${contactsPerRun} new people`}
            </button>
          )}
          <p className="mt-1 text-xs text-warmgray-500">Ready to request: {result.summary}</p>

          {(result.status === "sourced" || result.status === "cached") && (
            <ul className="mt-3 space-y-2">
              {result.contacts.map((contact) => (
                <li
                  key={contact.id}
                  className="rounded-md border border-brand-100 bg-white p-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-brand-900">{contact.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {/* Read-boundary guard - the SAME taint path as the
                          contacts grid: this URL arrives in a third-party
                          sourcing provider's response and is rendered before
                          anything stores it. See lib/safe-url. No href means
                          no "Profile" link, which is what a contact with no
                          profile already shows. */}
                      {externalHref(contact.linkedinUrl) && (
                        <a
                          href={externalHref(contact.linkedinUrl)}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="shrink-0 text-warmgray-500 underline hover:text-brand-900"
                        >
                          Profile
                        </a>
                      )}
                      <DraftEmailButton recipientKey={`contact-${contact.id}`} name={contact.name} />
                    </span>
                  </div>
                  {contact.title && <p className="text-warmgray-500">{contact.title}</p>}
                  {/* THREE conditions, not one. A non-null email is not enough
                      to render: `vikram.jolly@greenhill.com` was non-null,
                      deliverable, and belonged to a different bank entirely.
                      The backend gate is authoritative; this is defence in
                      depth, and it fails closed - anything that is not one of
                      the three renderable states shows "No email found". */}
                  {shouldRenderEmail(contact) ? (
                    <p className="font-mono text-[11px] text-brand-900">
                      {contact.email}
                      {/* The label says WHICH of the three it is. "Unverified"
                          covered a derived address and an unchecked one alike,
                          which are not the same promise to someone about to
                          write to a person they want to impress. */}
                      {emailLabel(contact.emailConfidence) && (
                        <span className="ml-1 font-sans text-[10px] uppercase tracking-wide text-warmgray-500">
                          · {emailLabel(contact.emailConfidence)}
                        </span>
                      )}
                    </p>
                  ) : (
                    <p className="text-warmgray-500">No email found</p>
                  )}
                  {/* The whole point of the search: why this person, not just who. */}
                  {contact.memo && <p className="mt-1 text-brand-900">{contact.memo}</p>}
                </li>
              ))}
              {result.contacts.some((c) => c.emailConfidence === "predicted") && (
                <li className="text-[11px] text-warmgray-500">
                  Addresses marked PREDICTED follow a format inferred from a confirmed work
                  address at this firm. The individual mailbox itself has not been verified, so
                  check the name is spelled the way the firm would write it before sending.
                </li>
              )}
              {result.contacts.some((c) => c.emailConfidence === "catch_all") && (
                <li className="text-[11px] text-warmgray-500">
                  CATCH-ALL means the firm’s mail server accepts anything at that domain, so the
                  address is plausible but the individual mailbox could not be confirmed.
                </li>
              )}
              {result.contacts.length === 0 && (
                <li className="text-xs text-warmgray-500">
                  Everyone this search found is already saved. Click again for different people, or
                  widen your target locations.
                </li>
              )}
            </ul>
          )}
          {result.missing.length > 0 && (
            <p className="mt-1 text-xs text-warmgray-500">
              Add your {result.missing.join(" and ")} in your profile for better matches.
            </p>
          )}

          {/* The raw payload is a debugging view: it only ARRIVES for internal
              accounts, so there is nothing here to hide for anyone else - see
              generateContactsAction. The resume readback below is a different
              thing, a disclosure a student is owed about their own data, so it
              stays for everyone. Only the label and the JSON change. */}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-warmgray-500 hover:text-brand-900">
              {result.query ? "What would be sent" : "What we read from your resume"}
            </summary>
            {result.query && (
              <>
                <p className="mt-2 text-xs text-warmgray-500">
                  Provider billed {result.creditsUsed} credits for this search.
                </p>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-brand-100 bg-brand-50/50 p-2 text-[11px] leading-relaxed text-brand-900">
                  {JSON.stringify(result.query, null, 2)}
                </pre>
              </>
            )}
            <p className="mt-2 text-xs text-warmgray-500">
              Read from your resume: {describeResume(result.resumeRead)}.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
