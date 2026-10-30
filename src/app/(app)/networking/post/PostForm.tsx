"use client";

import { useActionState, useState } from "react";
import { POST_BODY_MAX } from "@/lib/post-limits";
import { submitPost, type PostState } from "./actions";

export default function PostForm() {
  const [state, action, pending] = useActionState<PostState, FormData>(submitPost, {});
  const [body, setBody] = useState("");
  const left = POST_BODY_MAX - body.length;

  return (
    <form action={action} className="list-panel border border-brand-100 p-4">
      <label htmlFor="post-body" className="block text-sm font-medium text-brand-900">
        Share an update
      </label>
      <p className="mt-1 text-xs text-warmgray-500">
        This goes to the live feed, where everyone recruiting alongside you will see it.
      </p>

      <textarea
        id="post-body"
        name="body"
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={POST_BODY_MAX}
        placeholder="Superday at Evercore next week - anyone else going?"
        className="mt-3 w-full resize-y rounded-lg border border-brand-300 bg-transparent px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-500 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        {/* Counts down rather than up, and only starts mattering near the end.
            A live count from zero reads as a target to fill. */}
        <p className={`text-xs ${left < 60 ? "text-error-600" : "text-warmgray-500"}`}>
          {left < 60 ? `${left} characters left` : ""}
        </p>
        <button
          type="submit"
          disabled={pending || body.trim().length === 0}
          // Literal colours, not bg-brand-900/text-white. Both tokens invert
          // under [data-app-theme="terminal"] - brand-900 becomes white and
          // `white` becomes near-black - so the pill rendered white-on-white
          // inside this panel and vanished, leaving what looked like plain
          // grey text where the submit button should be.
          className="inline-flex h-10 items-center rounded-full bg-[#0b1526] px-5 text-sm font-medium text-[#ffffff] transition hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          {pending ? "Posting…" : "Post"}
        </button>
      </div>

      {state.error && (
        <p role="alert" className="mt-2 text-xs text-error-600">
          {state.error}
        </p>
      )}
    </form>
  );
}
