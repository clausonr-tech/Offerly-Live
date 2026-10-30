"use client";

import { useActionState, useState } from "react";
import { createPost, type PostActionState } from "./actions";
import { LINK_LABEL_KEYS, LINK_LABELS, POST_TYPE_LABELS, POST_TYPES } from "@/lib/feed";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as FirmProgramCategory[];

const inputClass =
  "w-full rounded-md border border-brand-300 bg-transparent px-3 py-2 text-sm text-brand-900 outline-none placeholder:text-warmgray-500 focus:border-accent-400";

export default function PostComposer() {
  const [state, formAction, pending] = useActionState<PostActionState, FormData>(
    createPost,
    undefined,
  );
  // An announcement is the one type with no date, so the date fields are
  // hidden for it rather than shown and ignored.
  const [type, setType] = useState<string>("event");
  // Drives whether the button-wording picker is worth showing at all.
  const [hasLink, setHasLink] = useState(false);
  const dated = type !== "announcement";

  return (
    <form action={formAction} className="max-w-2xl space-y-4">
      <Field label="What kind of post is this?">
        <select
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          className={inputClass}
        >
          {POST_TYPES.map((t) => (
            <option key={t} value={t}>
              {POST_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Title">
        <input name="title" required maxLength={200} className={inputClass} placeholder="Spring analyst info session" />
      </Field>

      <Field label="Description">
        <textarea
          name="body"
          required
          rows={5}
          maxLength={4000}
          className={inputClass}
          placeholder="Who it's for, what you'll cover, and how to sign up."
        />
      </Field>

      {dated && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts">
            <input type="datetime-local" name="startsAt" className={inputClass} />
          </Field>
          <Field label="Ends (optional)">
            <input type="datetime-local" name="endsAt" className={inputClass} />
          </Field>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Industry (optional)">
          <select name="category" defaultValue="" className={inputClass}>
            <option value="">Not sector-specific</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Who should see this?">
          <select name="schoolScope" defaultValue="all" className={inputClass}>
            <option value="all">Students at every school</option>
            <option value="own">Only my school</option>
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Location (optional)">
          <input name="location" maxLength={200} className={inputClass} placeholder="Huntsman Hall G06, or Zoom" />
        </Field>
        <Field label="Link (optional)">
          <input
            name="linkUrl"
            maxLength={500}
            className={inputClass}
            placeholder="Sign-up form, registration page…"
            onChange={(e) => setHasLink(!!e.target.value.trim())}
          />
        </Field>
      </div>

      {/* Only worth asking what the button should say once there is a link for
          it to point at. */}
      {hasLink && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What should the button say?">
            <select name="linkLabel" defaultValue="details" className={inputClass}>
              {LINK_LABEL_KEYS.map((k) => (
                <option key={k} value={k}>
                  {LINK_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-900 px-4 py-2 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Posting…" : "Post to feed"}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-warmgray-500">
        {label}
      </span>
      {children}
    </label>
  );
}
