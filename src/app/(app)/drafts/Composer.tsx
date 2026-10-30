"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Copy, Paperclip } from "lucide-react";

import { copyCountsAsSend } from "@/lib/copy-send";
import { MAX_EMAILS, ordinal } from "@/lib/outreach-ladder";

import { recordDraftCopied, saveDraftEdits, setDraftSent, type ComposerDraft } from "./actions";

// Every colour in this component is a literal hex, never a theme token like
// bg-white or text-white. The app's dark theme redefines those tokens
// (--color-white becomes near-black), which turned this white email into dark
// grey text on a black page. Literal values can't be re-skinned, so it stays a
// light, readable email whatever theme the rest of the app is in.

// Larger than Gmail's 13px compose default on purpose: this is where the
// student reads and edits the whole email, so legibility wins. The text itself
// is plain, so line breaks and blank lines carry over to Gmail exactly.
const BODY_STYLE = {
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: "15px",
  lineHeight: 1.6,
  color: "#202124",
} as const;

/** The body with each [bracketed placeholder] in red - what the student still has to fill in. */
function highlightBrackets(text: string): React.ReactNode[] {
  return text.split(/(\[[^\]\n]{2,}\])/g).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} style={{ color: "#d93025" }}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}


/** A Gmail-style compose window for one draft. */
export default function Composer({
  draft,
  scrollOnMount = false,
  onSent,
}: {
  draft: ComposerDraft;
  scrollOnMount?: boolean;
  /** Called once the email has been copied out to send. */
  onSent?: () => void;
}) {
  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // What the last copy recorded, so the note can say it and offer to take it back.
  const [sent, setSent] = useState<{ sendId: string; step: number; contactName: string } | null>(null);
  const [copied, setCopied] = useState<"email" | "subject" | null>(null);
  // Shown once the email is copied, when it goes with a resume: a browser can
  // only put text on the clipboard, never a file, so pasting into Gmail
  // brings the words and not the PDF. This is the next best thing - said at
  // the moment it matters, with the file one click away.
  const [attachReminder, setAttachReminder] = useState(false);
  // "I sent this": what Offerly has on record. Copying ticks it.
  const [isSent, setIsSent] = useState(Boolean(draft.sentAt));
  const [sending, startSend] = useTransition();
  const [saving, startSave] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollOnMount) rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollOnMount]);

  // Bracketed markers are where the model needed a fact it wasn't given.
  const unfilled = Array.from(new Set(`${subject}\n${body}`.match(/\[[^\]\n]{2,}\]/g) ?? []));
  const missingTo = !to.trim();

  /**
   * The email left Offerly: record it as sent.
   *
   * Copying is the send now - the student pastes it into their own mail - so
   * this saves the copied version, archives it beside what the model wrote,
   * and puts it on the contact's follow-up ladder. The server treats a second
   * copy of the same draft as the same email, so copying twice is harmless.
   */
  function recordSend() {
    setStatus(null);
    if (draft.attachmentName) setAttachReminder(true);
    startSend(async () => {
      const res = await recordDraftCopied(draft.id, { to, subject, body });
      if (res.error) {
        setStatus({ ok: false, text: res.error });
        return;
      }
      setSent(res.sent ?? null);
      setIsSent(true);
      if (!res.sent) setStatus({ ok: true, text: "Copied. Paste it into your email and send it from there." });
      onSent?.();
    });
  }

  async function copyText(text: string, which: "email" | "subject") {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setStatus({ ok: false, text: "Couldn't reach the clipboard. Select the text and press Cmd+C instead." });
      return;
    }
    setCopied(which);
    setTimeout(() => setCopied((c) => (c === which ? null : c)), 2000);
    if (which === "email") recordSend();
  }

  /**
   * Cmd+C (or right-click, Copy) anywhere in the composer. It counts as
   * sending only when it takes most of the body - see lib/copy-send.ts. The
   * body is a textarea, whose selection the document selection does not
   * report, so it is read off the element itself.
   */
  function onCopy(e: React.ClipboardEvent<HTMLDivElement>) {
    // Only a copy out of the body is the email. The To and Subject lines are
    // copied on their own all the time, and neither is the email.
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement)) return;
    const selected = t.value.slice(t.selectionStart ?? 0, t.selectionEnd ?? 0);
    if (copyCountsAsSend(selected, body)) recordSend();
  }

  /** Untick "I sent this", or Undo on the note - the same thing. */
  function unmarkSent() {
    setStatus(null);
    startSend(async () => {
      const res = await setDraftSent(draft.id, false, { to, subject, body });
      if (res.error) {
        setStatus({ ok: false, text: res.error });
        return;
      }
      setSent(null);
      setIsSent(false);
      setStatus({ ok: true, text: "Taken back. Not marked as sent." });
    });
  }

  /** Tick "I sent this" by hand - for an email sent without copying it here. */
  function markSentByHand() {
    setStatus(null);
    startSend(async () => {
      const res = await setDraftSent(draft.id, true, { to, subject, body });
      if (res.error) {
        setStatus({ ok: false, text: res.error });
        return;
      }
      setSent(res.sent ?? null);
      setIsSent(true);
      onSent?.();
    });
  }


  function save() {
    setStatus(null);
    startSave(async () => {
      const res = await saveDraftEdits(draft.id, subject, body);
      setStatus(res.error ? { ok: false, text: res.error } : { ok: true, text: "Saved." });
    });
  }

  const rowLabel = "w-16 shrink-0 text-[14px] text-[#5f6368]";
  const rowInput =
    "min-w-0 flex-1 bg-transparent text-[15px] text-[#202124] outline-none placeholder:text-[#80868b]";

  return (
    <div
      ref={rootRef}
      onCopy={onCopy}
      className="gmail-compose scroll-mt-6 overflow-hidden rounded-xl border border-[#dadce0] bg-[#ffffff] text-[#202124] shadow-[0_8px_24px_rgba(0,0,0,.35)]"
      style={{ fontFamily: '"Google Sans", Roboto, Arial, sans-serif', colorScheme: "light" }}
    >
      <div className="flex items-center justify-between gap-3 bg-[#f2f6fc] px-5 py-3">
        <span className="text-[15px] font-medium text-[#041e49]">New Message</span>
        {draft.contactName && (
          <span className="truncate text-[13px] text-[#444746]">To: {draft.contactName}</span>
        )}
      </div>

      <div className="px-5">
        <label className="flex items-center gap-3 border-b border-[#e0e0e0] py-3">
          <span className={rowLabel}>To</span>
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Their email address"
            className={rowInput}
          />
        </label>
        {missingTo && (
          <p className="mt-2 rounded-md bg-[#fef7e0] px-3 py-2 text-[13px] text-[#7a4f01]">
            No email address on file for {draft.contactName || "this person"}. Add it above to send.
          </p>
        )}
        <label className="flex items-center gap-3 border-b border-[#e0e0e0] py-3">
          <span className={rowLabel}>Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className={`${rowInput} font-medium`}
          />
        </label>
        {/* A textarea can't colour part of its text, so the body is drawn twice:
            a copy underneath with [brackets] in red, and the real textarea on
            top with invisible text and a visible caret. Both share one font,
            padding and wrapping, so every character sits in the same place.
            The copy sets the height; the textarea fills it. */}
        <div className="relative">
          <div
            aria-hidden="true"
            className="pointer-events-none min-h-[360px] w-full whitespace-pre-wrap break-words px-0 py-5"
            style={BODY_STYLE}
          >
            {highlightBrackets(body)}
            {/* A trailing newline only takes up a line once something follows it. */}
            {"​"}
          </div>
          <textarea
            aria-label="Message body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck
            className="absolute inset-0 block h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent px-0 py-5 outline-none selection:bg-[rgba(26,115,232,0.25)]"
            style={{ ...BODY_STYLE, color: "transparent", caretColor: "#202124" }}
          />
        </div>
        {draft.attachmentName && (
          <div className="mb-4 inline-flex max-w-xs items-center gap-2 rounded-md border border-[#dadce0] bg-[#f8f9fa] px-3 py-2 text-[14px] font-medium text-[#1a73e8]">
            <Paperclip size={15} className="shrink-0 text-[#5f6368]" />
            <span className="truncate">{draft.attachmentName}</span>
          </div>
        )}
      </div>

      {draft.notes && draft.notes.length > 0 && (
        <div className="mx-5 mb-4 rounded-md bg-[#e8f0fe] px-3 py-2 text-[13px] text-[#174ea6]">
          <p className="font-semibold">Before you send</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {draft.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      {unfilled.length > 0 && (
        <p className="mx-5 mb-4 rounded-md bg-[#fce8e6] px-3 py-2 text-[13px] text-[#a50e0e]">
          <strong className="font-semibold">Red text in [brackets]</strong> is info only you have. Replace each one
          with your own words before sending.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-[#e0e0e0] bg-[#ffffff] px-5 py-4">
        <button
          type="button"
          onClick={() => copyText(body, "email")}
          disabled={sending}
          className="inline-flex items-center gap-2 rounded-full bg-[#0b57d0] px-6 py-2.5 text-[15px] font-medium text-[#ffffff] hover:bg-[#0842a0] disabled:opacity-60"
        >
          {copied === "email" ? <Check size={16} /> : <Copy size={16} />}
          {copied === "email" ? "Copied" : "Copy email"}
        </button>
        <button
          type="button"
          onClick={() => copyText(subject, "subject")}
          className="inline-flex items-center gap-2 rounded-full border border-[#dadce0] bg-[#ffffff] px-5 py-2.5 text-[15px] font-medium text-[#1f1f1f] hover:bg-[#f1f3f4]"
        >
          {copied === "subject" ? "Copied" : "Copy subject"}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-full border border-[#dadce0] bg-[#ffffff] px-5 py-2.5 text-[15px] font-medium text-[#1f1f1f] hover:bg-[#f1f3f4] disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {status && (
          <span className={`text-[14px] ${status.ok ? "text-[#137333]" : "text-[#c5221f]"}`}>
            {status.text}
          </span>
        )}

        {attachReminder && draft.attachmentName && (
          <div
            role="alert"
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border-2 border-[#f9ab00] bg-[#fef7e0] px-3 py-2.5 text-[14px] text-[#7a4f01] motion-safe:animate-[pulse_0.9s_ease-in-out_3]"
          >
            <Paperclip size={16} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">Now attach your resume</span> ({draft.attachmentName}). Pasting brings
              the text only - Gmail can&apos;t take a file from a copy, so drag it in or use the paperclip.
            </span>
            <a
              href="/api/resume/current"
              download={draft.attachmentName}
              className="shrink-0 font-semibold underline underline-offset-2 hover:text-[#5c3b00]"
            >
              Download it
            </a>
          </div>
        )}
        {sent && (
          // The record a copy just made, said out loud and reversible - a copy
          // is a guess at a send, and a wrong guess should cost one click.
          <p
            role="status"
            className="flex w-full flex-wrap items-center gap-x-2 rounded-md bg-[#e6f4ea] px-3 py-2 text-[13px] text-[#137333]"
          >
            <span>
              Marked as sent to {sent.contactName} · {ordinal(sent.step)} of {MAX_EMAILS} emails. A follow-up
              reminder comes in a week if they don&apos;t reply.
            </span>
            <button
              type="button"
              onClick={unmarkSent}
              disabled={sending}
              className="font-medium underline underline-offset-2 hover:text-[#0d5626]"
            >
              Undo
            </button>
          </p>
        )}
        {sent && unfilled.length > 0 && (
          <p className="w-full rounded-md bg-[#fce8e6] px-3 py-2 text-[13px] text-[#a50e0e]">
            This still has text in [brackets]. Fill it in before you send it.
          </p>
        )}

        <p className="w-full text-[13px] text-[#5f6368]">
          Copy the email and send it from your own inbox. Copying it (or pressing Cmd+C on the whole
          email) marks it sent and starts the follow-up clock. Read it through first: it was written
          by AI and can get details about you wrong.
          {draft.attachmentName && " Attach your resume there too - it isn't copied with the text."}
        </p>
      </div>

      {/* Outside the email and under it: a question about the email, not a
          part of it. Copying ticks it; ticking it by hand covers an email
          sent some other way; unticking takes the record back. What it says
          is what the rest of the app believes - the networking table, the
          follow-up clock, the thank-you prompt. */}
      <label className="flex cursor-pointer items-center gap-3 border-t border-[#e0e0e0] bg-[#f8f9fa] px-5 py-3 text-[14px] text-[#202124]">
        <input
          type="checkbox"
          checked={isSent}
          disabled={sending}
          onChange={(e) => (e.target.checked ? markSentByHand() : unmarkSent())}
          className="h-4 w-4 cursor-pointer accent-[#0b57d0]"
        />
        <span>
          I sent this email{draft.contactName ? ` to ${draft.contactName}` : ""}
          <span className="ml-2 text-[12px] text-[#5f6368]">
            {isSent ? "Recorded as sent" : "Tick it once it has gone, so your follow-ups stay accurate"}
          </span>
        </span>
      </label>
    </div>
  );
}
