"use client";

// Submitting the draft form over the streaming route, with the server action
// as the fallback.
//
// Three failures, handled differently on purpose:
//
//  - The browser cannot read a stream at all (`canStream`). Nothing is
//    requested; the form posts to the server action.
//
//  - The stream never STARTS (the flag is off and the route 404s, an old
//    deploy, a 401, the fetch is refused, or the browser gives no
//    `response.body`). Nothing has been drafted and no quota has been spent,
//    so the form posts to the server action instead and the student sees
//    exactly what they see today.
//
//  - The stream DIES after it started. The draft may already have been
//    written and charged to the student's monthly allowance, so re-submitting
//    would risk drafting - and billing - twice. That reports an error and
//    points at the saved-drafts page, the same shape of outcome as a failed
//    action, with the typed form left intact.
//
// What the student sees at each stage is not here: it is a pure function of
// the frames so far, in ./draft-stream-view, which is where the tests drive it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { generateDraft } from "./actions";
import {
  DEAD_STREAM,
  IDLE_STREAM_STATE,
  applyFrame,
  canStream,
  draftArrived,
  type DraftStreamFrame,
  type DraftStreamState,
} from "./draft-stream-view";

export function useDraftStream({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<DraftStreamState>(IDLE_STREAM_STATE);
  const router = useRouter();
  const abort = useRef<AbortController | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      abort.current?.abort();
    };
  }, []);

  const apply = useCallback(
    (frame: DraftStreamFrame) => {
      if (!live.current) return;
      setState((prev) => applyFrame(prev, frame));
      // The row has been written. `runGenerateDraft` revalidates /outreach and
      // /contacts, but a route handler's revalidation only invalidates the
      // server cache - nothing tells this router about it, where the form's
      // old transition-wrapped action did. Without this the page still says
      // the student has no past emails right after writing one.
      if (frame.type === "final") router.refresh();
    },
    [router],
  );

  /**
   * Post the form. Resolves to false when the stream never started, which is
   * the caller's signal to run the server action instead.
   */
  const streamSubmit = useCallback(
    async (formData: FormData): Promise<boolean> => {
      const controller = new AbortController();
      abort.current = controller;
      let response: Response;
      try {
        response = await fetch("/api/drafts/generate", { method: "POST", body: formData, signal: controller.signal });
      } catch {
        return false;
      }
      if (!response.ok || !response.body) return false;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let frames = 0;
      let terminal = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line.
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let frame: DraftStreamFrame;
            try {
              frame = JSON.parse(line.slice(5).trim()) as DraftStreamFrame;
            } catch {
              continue;
            }
            frames++;
            if (frame.type === "final" || frame.type === "error") terminal = true;
            apply(frame);
          }
        }
      } catch {
        // Fell over mid-read.
      }

      if (terminal) return true;
      // It started and then stopped without saying how it ended. Do not
      // re-submit: the draft may already be saved and already charged.
      if (frames > 0 || response.status === 200) {
        apply({ type: "error", message: DEAD_STREAM });
        return true;
      }
      return false;
    },
    [apply],
  );

  const submit = useCallback(
    async (formData: FormData) => {
      setState({ ...IDLE_STREAM_STATE, pending: true, stage: "starting" });
      const streamable = enabled && canStream(typeof window === "undefined" ? undefined : (window as unknown as Record<string, unknown>));
      if (streamable && (await streamSubmit(formData))) return;
      // The unstreamed path, byte-for-byte what the form did before any of
      // this existed. `streamed` stays false, so the student is not told about
      // a change to text they never saw.
      const result = await generateDraft(undefined, formData);
      if (!live.current) return;
      if (result?.draft) {
        setState(draftArrived(result.draft));
        router.refresh();
      }
      else setState({ ...IDLE_STREAM_STATE, error: result?.error ?? "Failed to generate draft" });
    },
    [enabled, router, streamSubmit],
  );

  const reset = useCallback(() => setState(IDLE_STREAM_STATE), []);

  return { ...state, submit, reset };
}
