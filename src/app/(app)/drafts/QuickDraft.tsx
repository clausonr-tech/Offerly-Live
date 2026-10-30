"use client";

import Link from "next/link";
import { Mail, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import Composer from "./Composer";
import type { ComposerDraft } from "./actions";
import { draftEmailForContact } from "./quick-draft-actions";
import StagedProgress, { DRAFT_STAGES } from "@/components/StagedProgress";

/**
 * The one-click email: a "Draft email" button beside any contact opens a panel
 * in the bottom-right corner with the email already written, without leaving
 * the page. The panel is the same Composer the Email drafts page uses, so
 * copying, editing and "I sent this" behave exactly as they do there, and the
 * draft and every edit are saved the same way.
 *
 * One panel for the whole app, held by the provider in the (app) layout, so a
 * button anywhere opens the same one and switching person replaces it.
 */

type Target = { key: string; name: string };
type PanelState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; draft: ComposerDraft; reused: boolean };

const QuickDraftContext = createContext<((target: Target) => void) | null>(null);

export function QuickDraftProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  // Which request the panel is showing, so a slow answer for someone the
  // student has since moved on from never lands in the panel.
  const request = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback((t: Target, fresh: boolean) => {
    const mine = ++request.current;
    setTarget(t);
    setState({ kind: "loading" });
    draftEmailForContact(t.key, fresh)
      .then((res) => {
        if (mine !== request.current) return;
        setState("error" in res ? { kind: "error", message: res.error } : { kind: "ready", draft: res.draft, reused: res.reused });
      })
      .catch(() => {
        if (mine === request.current) setState({ kind: "error", message: "Couldn't write that email. Try again." });
      });
  }, []);

  const open = useCallback(
    (t: Target) => {
      // The same person again: show what is already there rather than asking twice.
      if (target?.key === t.key && state.kind !== "error") return;
      load(t, false);
    },
    [load, target, state.kind],
  );

  const close = useCallback(() => {
    request.current++;
    setTarget(null);
  }, []);

  useEffect(() => {
    if (!target) return;
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, close]);

  return (
    <QuickDraftContext.Provider value={open}>
      {children}
      {target && (
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-label={`Email to ${target.name}`}
          // Above the messages bubble in the same corner (bottom-5, 48px),
          // never over it. Full width less the gutter on a phone.
          className="fixed inset-x-4 bottom-20 z-50 flex max-h-[calc(100dvh-7rem)] flex-col overflow-hidden rounded-xl border border-brand-100 bg-[#ffffff] shadow-[0_20px_44px_-16px_rgba(11,21,38,0.55)] outline-none sm:inset-x-auto sm:right-5 sm:w-[34rem]"
        >
          <div className="flex items-start justify-between gap-3 border-b border-[#c5cfe0] px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#0b1526]">Email to {target.name}</p>
              <p className="truncate text-xs text-[#5f6b7a]">
                {state.kind === "ready"
                  ? state.draft.to || "No email address on file - add one in the To line"
                  : "Drafting from their profile and yours"}
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="shrink-0 rounded-md p-1 text-[#5f6b7a] hover:bg-[#eef2f8] hover:text-[#0b1526]"
            >
              <X size={18} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {state.kind === "loading" && (
              // Staged, not a bare spinner: the wait is ~half a minute, and
              // naming the pipeline's current step makes it feel accounted
              // for. The finished, checked email still arrives all at once.
              <StagedProgress stages={DRAFT_STAGES} sublabel="About half a minute" />
            )}
            {state.kind === "error" && (
              <div className="py-6 text-center">
                <p className="text-sm text-[#b3261e]">{state.message}</p>
                <div className="mt-3 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => load(target, false)}
                    className="rounded-md bg-[#0b1526] px-3 py-1.5 text-xs font-medium text-[#ffffff] hover:bg-[#1b2f4d]"
                  >
                    Try again
                  </button>
                  <Link
                    href="/outreach/email"
                    onClick={close}
                    className="rounded-md border border-[#c5cfe0] px-3 py-1.5 text-xs font-medium text-[#0b1526] hover:bg-[#eef2f8]"
                  >
                    Use the full form
                  </Link>
                </div>
              </div>
            )}
            {state.kind === "ready" && (
              <>
                {state.reused && (
                  <p className="mb-2 text-xs text-[#5f6b7a]">
                    Your email to {target.name} from before, as you left it.
                  </p>
                )}
                <Composer key={state.draft.id} draft={state.draft} />
              </>
            )}
          </div>

          {state.kind === "ready" && (
            <div className="flex items-center justify-between gap-2 border-t border-[#c5cfe0] px-4 py-2.5">
              <button
                type="button"
                onClick={() => load(target, true)}
                className="text-xs font-medium text-[#24447a] hover:underline"
              >
                Write a new one
              </button>
              <Link
                href={`/drafts/${state.draft.id}`}
                onClick={close}
                className="text-xs font-medium text-[#24447a] hover:underline"
              >
                Open in Email drafts →
              </Link>
            </div>
          )}
        </div>
      )}
    </QuickDraftContext.Provider>
  );
}

/**
 * "Draft email", beside a contact's name. Opens the panel above with a cold
 * email to them. Outside the (app) layout, where there is no panel, it falls
 * back to the Email drafts page addressed to them.
 */
export function DraftEmailButton({
  recipientKey,
  name,
  className = "",
}: {
  /** "contact-<id>" or "directory-<id>". */
  recipientKey: string;
  name: string;
  className?: string;
}) {
  const open = useContext(QuickDraftContext);
  const label = `Draft an email to ${name}`;
  // Filled blue so it reads as the action on the row. Literal hex, not the
  // accent token: the dark theme turns accent-500 white.
  const cls = `inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[#24447a] px-2.5 py-1 text-[11px] font-semibold text-[#ffffff] shadow-sm hover:bg-[#1c3560] ${className}`;
  if (!open) {
    const id = recipientKey.startsWith("contact-") ? recipientKey.slice("contact-".length) : null;
    return (
      <Link href={id ? `/outreach/email?contact=${id}` : "/outreach/email"} aria-label={label} className={cls}>
        <Mail size={12} aria-hidden />
        Draft email
      </Link>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        // Rows are often links themselves; the button must not follow them.
        e.preventDefault();
        e.stopPropagation();
        open({ key: recipientKey, name });
      }}
      className={cls}
    >
      <Mail size={12} aria-hidden />
      Draft email
    </button>
  );
}
