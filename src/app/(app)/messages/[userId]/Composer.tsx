"use client";

import { useActionState, useEffect, useRef } from "react";
import { Send } from "lucide-react";
import { MESSAGE_MAX } from "@/lib/message-limits";
import { send, type SendState } from "../actions";

export default function Composer({ recipientId, name }: { recipientId: string; name: string }) {
  const action = send.bind(null, recipientId);
  const [state, formAction, pending] = useActionState<SendState, FormData>(action, undefined);
  const ref = useRef<HTMLFormElement>(null);

  // React resets an uncontrolled form once its action settles, so a sent
  // message clears the box on its own. On a REJECTED send it would clear it
  // too, throwing away what they wrote - so the reset is only allowed through
  // when the send actually succeeded.
  useEffect(() => {
    if (state && !state.error) {
      ref.current?.reset();
      const box = ref.current?.elements.namedItem("body");
      if (box instanceof HTMLTextAreaElement) grow(box);
    }
  }, [state]);

  return (
    <form ref={ref} action={formAction} className="mt-4">
      <label htmlFor="body" className="sr-only">
        Message to {name}
      </label>
      {/* One rounded bubble holding the text and the send button, the shape
          the messages above it have. The ring is on the bubble, not the
          textarea, so focus outlines the whole thing. */}
      <div className="ui-round-lg flex items-end gap-2 border border-brand-200 bg-white p-1.5 pl-4 focus-within:border-accent-500 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-500">
        <textarea
          id="body"
          name="body"
          rows={1}
          maxLength={MESSAGE_MAX}
          required
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={state?.error ? "send-error" : "send-hint"}
          placeholder={`Message ${name}`}
          onInput={(e) => grow(e.currentTarget)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Not while an IME is
            // composing, where Enter picks the character.
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (!pending && e.currentTarget.value.trim()) e.currentTarget.form?.requestSubmit();
          }}
          className="max-h-48 min-h-8 w-full resize-none self-center bg-transparent py-1.5 text-base text-brand-900 placeholder:text-warmgray-500 focus-visible:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-brand-900 px-4 text-sm font-medium text-white transition hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed disabled:opacity-80"
        >
          <Send size={15} aria-hidden="true" />
          {pending ? "Sending" : "Send"}
        </button>
      </div>
      <p id="send-hint" className="mt-1.5 px-1 text-[11px] text-warmgray-500">
        Enter to send · Shift+Enter for a new line
      </p>
      {state?.error && (
        <p id="send-error" role="alert" className="mt-2 text-sm text-error-600">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** The box grows with what is typed, up to its max-height, then scrolls. */
function grow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
