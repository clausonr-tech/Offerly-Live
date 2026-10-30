"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Plus, X } from "lucide-react";

import { POST_BODY_MAX, POST_TITLE_MAX } from "@/lib/post-limits";
import { publishPost, type ComposeState } from "./compose-actions";

/**
 * The + beside the Feed heading, and the dialog it opens.
 *
 * A native <dialog> with showModal(), not a hand-rolled overlay. It brings the
 * focus trap, the Escape handler, `inert` on everything behind it and the top
 * layer for free - all things the app would otherwise reimplement, and the top
 * layer specifically matters here: this page's panels create stacking contexts
 * (backdrop-filter on .home-panel, transforms on the mount animation), and a
 * position:fixed overlay inside one of those is boxed into its column instead
 * of covering the viewport. That exact bug is why PlatformerGame portals
 * itself out. The top layer is not subject to any of it.
 *
 * It stays in the DOM where it is rendered rather than portalling, which is
 * what keeps it inside the [data-app-theme] scope - a portal to <body> lands
 * outside the theme and renders light-on-black.
 */
export default function FeedComposer() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // Object URL for the chosen file, so the student sees what they attached
  // before publishing rather than trusting a filename.
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const left = POST_BODY_MAX - body.length;
  const empty = !title.trim() && !body.trim() && !fileName;

  // Revoking is not optional: each object URL pins the whole file in memory
  // until it is released, and a student swapping through several images would
  // hold every one of them.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const clearImage = () => {
    setPreview((url) => {
      if (url) URL.revokeObjectURL(url);
      return null;
    });
    setFileName(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const close = () => {
    dialogRef.current?.close();
  };

  /**
   * The action, with the tidy-up on the far side of a successful publish.
   *
   * Deliberately here rather than in an effect watching `state.ok`. An effect
   * that calls setState on a state change is a cascading render, and it also
   * cannot tell a fresh success from a re-render carrying the same flag - so a
   * second post that returned the identical state would not close the dialog.
   * Awaiting the result reads in the order it happens.
   *
   * Only on success: the dialog stays open on an error with everything still
   * typed in it. A dialog that closes optimistically and throws away what was
   * written because the image was 6MB is how people lose a post.
   */
  const [state, action, pending] = useActionState<ComposeState, FormData>(
    async (prev, formData) => {
      const result = await publishPost(prev, formData);
      if (result.ok) {
        setTitle("");
        setBody("");
        clearImage();
        formRef.current?.reset();
        dialogRef.current?.close();
        // revalidatePath ran on the server; this is what makes THIS client
        // tree re-fetch, so the new post appears without a manual reload.
        router.refresh();
      }
      return result;
    },
    {},
  );

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        aria-label="Write a post"
        title="Write a post"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-brand-200 text-brand-900 transition-colors hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <Plus size={15} aria-hidden="true" />
      </button>

      <dialog
        ref={dialogRef}
        // Closing by backdrop click: the click target is the <dialog> itself
        // only when the backdrop was hit, since the panel inside it swallows
        // clicks on the content.
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
        // `dialog` carries a browser default border, padding and margin that
        // would frame the panel in a second box; the reset lives here rather
        // than in globals.css because this is the only dialog using it.
        // `backdrop:` is Tailwind's ::backdrop variant.
        className="rounded-xl m-auto w-[min(42rem,calc(100vw-2rem))] border-0 bg-transparent p-0 backdrop:bg-[#0b1526]/45 backdrop:backdrop-blur-[2px]"
      >
        <form
          ref={formRef}
          action={action}
          // bg-white, not bg-background: --color-background stays cream in the
          // Dealroom theme, so a panel using it renders cream with light text
          // on it. --color-white is the app's themed surface token.
          className="rounded-xl flex max-h-[85vh] flex-col overflow-hidden border border-brand-100 bg-white shadow-[0_24px_60px_-20px_rgba(11,21,38,0.55)]"
        >
          <div className="flex items-center justify-between border-b border-brand-100 px-5 py-3.5">
            <h2 className="text-base font-medium text-brand-900">New post</h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-warmgray-500 transition-colors hover:bg-brand-50 hover:text-brand-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          {/* Scrolls independently of the header and footer, so the Publish
              button stays reachable with a tall image attached. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-warmgray-500">
                Title
              </span>
              <input
                name="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={POST_TITLE_MAX}
                placeholder="Superday at Evercore next week"
                className="ui-round-md w-full border border-brand-300 bg-transparent px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-500 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
              />
            </label>

            <div className="mt-4">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-warmgray-500">
                Image
              </span>

              {/* The input itself is visually hidden but still the real
                  control - `sr-only` rather than display:none, so it keeps its
                  place in the tab order and the label still operates it. */}
              <input
                ref={fileRef}
                type="file"
                name="image"
                accept="image/jpeg,image/png"
                id="post-image"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return clearImage();
                  setPreview((old) => {
                    if (old) URL.revokeObjectURL(old);
                    return URL.createObjectURL(file);
                  });
                  setFileName(file.name);
                }}
              />

              {preview ? (
                <div className="ui-round-md relative overflow-hidden border border-brand-100">
                  {/* Same rule as the feed card, and the same shape of cap:
                      both axes bounded, both auto, so the preview is the real
                      picture scaled - what you approve here is what publishes.
                      Capped a little tighter than the feed's, since this one
                      shares a dialog with three other fields. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={preview}
                    alt=""
                    className="mx-auto block h-auto max-h-64 w-auto max-w-full"
                  />
                  <button
                    type="button"
                    onClick={clearImage}
                    aria-label="Remove image"
                    className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#0b1526]/75 text-[#ffffff] transition hover:bg-[#0b1526] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <label
                  htmlFor="post-image"
                  className="ui-round-md flex cursor-pointer items-center justify-center gap-2 border border-dashed border-brand-200 px-4 py-6 text-sm text-warmgray-500 transition-colors hover:border-brand-300 hover:text-brand-900"
                >
                  <ImagePlus size={16} aria-hidden="true" />
                  Attach an image
                </label>
              )}
              {fileName && (
                <p className="mt-1.5 truncate text-xs text-warmgray-500">{fileName}</p>
              )}
            </div>

            <label className="mt-4 block">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-warmgray-500">
                Post
              </span>
              <textarea
                name="body"
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={POST_BODY_MAX}
                placeholder="What happened, what you're working on, or what you're asking."
                className="ui-round-md w-full resize-y border border-brand-300 bg-transparent px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-500 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
              />
            </label>

            {state.error && (
              <p role="alert" className="mt-3 text-xs text-error-600">
                {state.error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-brand-100 px-5 py-3.5">
            {/* Counts down rather than up, and only once it starts mattering -
                a live count from zero reads as a target to fill. Matches the
                standalone composer's rule. */}
            <p className={`text-xs ${left < 60 ? "text-error-600" : "text-warmgray-500"}`}>
              {left < 60 ? `${left} characters left` : ""}
            </p>

            {/* Bottom right, as asked. Literal colours, not bg-brand-900 and
                text-white: both tokens invert under the Dealroom theme -
                brand-900 becomes white and `white` becomes near-black - so the
                pill rendered white-on-white inside a panel and vanished. */}
            <button
              type="submit"
              disabled={pending || empty}
              className="inline-flex h-10 shrink-0 items-center rounded-full bg-[#0b1526] px-5 text-sm font-medium text-[#ffffff] transition hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              {pending ? "Publishing…" : "Publish"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
