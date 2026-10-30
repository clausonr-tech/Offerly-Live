// The draft form's other front door: the same work as the `generateDraft`
// action, reported as it happens so the composer can show the email being
// written instead of a timer.
//
// It is the SAME work - `runGenerateDraft` is one function and both callers
// run it (app/(app)/drafts/draft-request). This route adds an `onEvent` and a
// server-sent-event wire format on top; it does not add a second pipeline, a
// second set of gates or a second place that writes the row.
//
// Off unless OFFERLY_DRAFT_STREAM=on. A 404 here is a normal, expected
// outcome, and the client answers it by posting to the server action instead
// (useDraftStream), so the form works the same with the flag off, on an old
// deploy, or in a browser that cannot read a stream.

import { getOptionalUser } from "@/lib/current-user";
import { blockedInForm } from "@/lib/content-limits";
import { draftFormLabels } from "@/lib/draft-field-labels";
import {
  DRAFT_INPUT_FIELDS,
  DRAFT_SKIP_FIELDS,
  draftStreamingEnabled,
  runGenerateDraft,
} from "@/app/(app)/drafts/draft-request";

// The same budget the outreach page gives the action it replaces.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function sse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** One event, then nothing - used for a refusal that happens before any work. */
function oneEvent(event: unknown, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sse(event));
        controller.close();
      },
    }),
    { status, headers: STREAM_HEADERS },
  );
}

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform and X-Accel-Buffering keep a proxy from holding the whole
  // response back, which would turn the stream into the wait it replaces.
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
} as const;

export async function POST(request: Request): Promise<Response> {
  // Off by default. 404 rather than an error event: the client treats it as
  // "this deploy doesn't stream" and posts to the action instead.
  if (!draftStreamingEnabled()) return new Response("Draft streaming is off.", { status: 404 });

  // Checked here rather than inside, because getCurrentUser redirects, and a
  // redirect thrown inside a stream body reaches the student as nothing at all.
  // A 401 sends them down the action path, which redirects properly.
  const user = await getOptionalUser();
  if (!user || user.accountType === "firm") return new Response("Not signed in.", { status: 401 });

  const formData = await request.formData();

  // Slurs, hateful terms or profanity anywhere on the form stop here, before
  // anything reaches the model (lib/content-limits) - the same call, on the
  // same fields, as the server action makes. runGenerateDraft makes it again:
  // every entry point carries the check in its own body so that adding one
  // cannot quietly skip it (scripts/content-limits-coverage-test).
  // The hand-kept list names 15 of the 139 boxes a student can type into, so
  // everything else came back as "One of your answers" - including `purpose`,
  // the custom occasion's only box. draftFormLabels() derives the rest from the
  // question definitions; the hand list stays on top because it owns the
  // recipient block and reads better for the intro fields.
  const blocked = blockedInForm(formData, { ...draftFormLabels(), ...Object.fromEntries(DRAFT_INPUT_FIELDS) }, DRAFT_SKIP_FIELDS);
  if (blocked) return oneEvent({ type: "error", message: blocked });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      // The student may close the tab mid-draft. Enqueueing into a closed
      // stream throws, and that must not look like a failed draft: the work
      // carries on and the row is still written.
      const send = (event: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(sse(event));
        } catch {
          open = false;
        }
      };

      try {
        const result = await runGenerateDraft(formData, { onEvent: send });
        if (result?.error) send({ type: "error", message: result.error });
        else if (result?.draft) send({ type: "final", draft: result.draft });
        else send({ type: "error", message: "Failed to generate draft" });
      } catch (err) {
        console.error("[draft-stream] route failed", err);
        send({ type: "error", message: err instanceof Error ? err.message : "Failed to generate draft" });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      }
    },
  });

  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
}
