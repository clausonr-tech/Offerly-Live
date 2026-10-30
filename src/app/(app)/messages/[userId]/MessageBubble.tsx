"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { MESSAGE_EDIT_WINDOW_MS, MESSAGE_MAX } from "@/lib/message-limits";
import { edit, type EditState } from "../actions";

/**
 * One message in the thread. The student's own can be changed for 10 minutes
 * after sending (lib/message-limits); the Edit button goes away on its own when
 * that runs out, and the server refuses a late save either way.
 *
 * The age label arrives formatted from the server, so the server and browser
 * never render two different "x minutes ago".
 */
export default function MessageBubble({
  id,
  body,
  fromMe,
  sentAt,
  when,
  whenTitle,
  edited,
}: {
  id: string;
  body: string;
  fromMe: boolean;
  /** ISO time it was sent: the edit window counts from here. */
  sentAt: string;
  when: string;
  whenTitle: string;
  edited: boolean;
}) {
  // The window is checked after mount, not during render - the server's and
  // the browser's clocks differ - and closes on its own while the page is
  // open: a timer flips `expired` when the ten minutes run out.
  const [mounted, setMounted] = useState(false);
  const [expired, setExpired] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!fromMe) return;
    const left = new Date(sentAt).getTime() + MESSAGE_EDIT_WINDOW_MS - Date.now();
    const t = setTimeout(() => {
      setMounted(true);
      if (left <= 0) setExpired(true);
    }, 0);
    const end = left > 0 ? setTimeout(() => setExpired(true), left) : undefined;
    return () => {
      clearTimeout(t);
      if (end) clearTimeout(end);
    };
  }, [fromMe, sentAt]);
  const editable = fromMe && mounted && !expired;

  const bubble = fromMe ? "bg-brand-900 text-white" : "border border-brand-200 bg-brand-50 text-brand-900";
  const muted = fromMe ? "text-white/70" : "text-warmgray-500";

  return (
    <div className={`ui-round-lg max-w-[85%] px-4 py-2.5 ${bubble} ${editing ? "w-full" : ""}`}>
      {editing && editable ? (
        <EditForm id={id} body={body} onDone={() => setEditing(false)} />
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body}</p>
          <p className={`mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] ${muted}`}>
            <time dateTime={sentAt} title={whenTitle}>
              {when}
            </time>
            {edited && <span>· Edited</span>}
            {editable && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label="Edit this message"
                className="ml-auto uppercase underline-offset-2 hover:underline"
              >
                Edit
              </button>
            )}
          </p>
        </>
      )}
    </div>
  );
}

function EditForm({ id, body, onDone }: { id: string; body: string; onDone: () => void }) {
  const [state, action, pending] = useActionState<EditState, FormData>(edit.bind(null, id), undefined);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={action}>
      <label htmlFor={`edit-${id}`} className="sr-only">
        Edit your message
      </label>
      <textarea
        ref={ref}
        id={`edit-${id}`}
        name="body"
        defaultValue={body}
        rows={Math.min(8, Math.max(2, body.split("\n").length))}
        maxLength={MESSAGE_MAX}
        required
        aria-invalid={state?.error ? true : undefined}
        aria-describedby={state?.error ? `edit-error-${id}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
          // Enter saves, as it sends in the box below; Shift+Enter is a new line.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        className="ui-round-md w-full resize-none bg-white px-3 py-2 text-sm text-brand-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      />
      {state?.error && (
        <p id={`edit-error-${id}`} role="alert" className="mt-1 text-xs text-white">
          {state.error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-3 text-xs">
        <button type="button" onClick={onDone} className="text-white/80 hover:text-white hover:underline">
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="rounded-full bg-white px-3 py-1 font-medium text-brand-900 disabled:opacity-70"
        >
          {pending ? "Saving" : "Save"}
        </button>
      </div>
    </form>
  );
}
