"use client";

import { useRef, useState, useTransition } from "react";
import { Camera } from "lucide-react";
import { crestUrl } from "@/lib/school-crest";
import { useCrestTint } from "@/lib/use-crest-tint";
import { removeAvatar, uploadAvatar } from "./actions";

/**
 * The student's picture: their own photo if they have uploaded one, otherwise
 * their school's crest.
 *
 * The crest is the default rather than a placeholder, and that is the point of
 * it - a feed of crests tells you at a glance who is from where, which a wall
 * of grey initials does not. A photo overrides it; removing the photo puts it
 * back.
 */
export default function ProfilePhoto({
  userId,
  photoVersion,
  crestDomain,
  initials,
  name,
}: {
  userId: string;
  /** First characters of the stored key, or null when there is no photo. Used
   *  as a cache-busting version - see getFeed for why the URL must change. */
  photoVersion: string | null;
  crestDomain: string | null;
  initials: string;
  name: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Bumped after a successful upload so the <img> refetches. The storage key
  // changes on every upload, but this element's src does not - it is keyed by
  // user - so without it the browser keeps showing the cached old photo.
  const [version, setVersion] = useState(0);
  const [photo, setPhoto] = useState(Boolean(photoVersion));
  // Only for a crest - a photo fills the disc, so there is no space to tint.
  const tint = useCrestTint(photo ? null : crestDomain);

  const src = photo
    ? `/api/avatar/${userId}?v=${photoVersion ?? ""}-${version}`
    : crestDomain
      ? crestUrl(crestDomain, 256)
      : null;

  function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    const data = new FormData();
    data.set("avatar", file);
    startTransition(async () => {
      const res = await uploadAvatar({}, data);
      if (res.error) setError(res.error);
      else {
        setPhoto(true);
        setVersion((v) => v + 1);
      }
    });
  }

  function onRemove() {
    setError(null);
    startTransition(async () => {
      await removeAvatar();
      setPhoto(false);
    });
  }

  return (
    <div>
      {/* group/photo so the hover overlay is driven by the circle itself and
          not by anything else on the page that happens to be hovered. */}
      <div className="group/photo relative h-32 w-32">
        {/* White in both themes when it is holding a CREST, for the reason
            spelled out in LogoAvatar: these marks are drawn for a light ground
            and vanish on a dark one. A photo covers the whole disc, so its
            backdrop is never seen and it keeps the neutral surface. */}
        <div
          className={`flex h-32 w-32 items-center justify-center overflow-hidden rounded-full border border-brand-200 ${
            photo ? "bg-brand-50" : "bg-[#ffffff]"
          }`}
          style={!photo && tint ? { backgroundColor: tint } : undefined}
        >
          {src ? (
            // The crest is a remote favicon service and the photo comes from
            // our own route; neither benefits from the optimiser, and both
            // change URL on update rather than being cached by path.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={`${name}'s profile picture`}
              // A photo and a crest want opposite treatment, which is why this
              // is not one class for both. A photo is a photograph: cover it,
              // and cropping the edges is correct. A crest is artwork on its
              // own background - covering it crops the shield and pushes what
              // is left off-centre, so it gets contained and padded instead,
              // the same way the feed avatar handles it.
              className={
                photo
                  ? "h-full w-full object-cover"
                  // 12% of 128px. Same reasoning as LogoAvatar: the mask
                  // is a circle, so artwork fitted to the square inside it
                  // loses its edges.
                  : "h-full w-full object-contain p-[15px]"
              }
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-3xl font-medium text-warmgray-500">
              {initials}
            </span>
          )}
        </div>

        {/* The whole circle is the control, not a small pencil in a corner:
            the picture is the affordance people already expect to click. */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={pending}
          aria-label={photo ? "Change profile photo" : "Upload a profile photo"}
          className="absolute inset-0 flex items-center justify-center rounded-full bg-[#0b1526]/60 text-[#ffffff] opacity-0 transition-opacity duration-150 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 group-hover/photo:opacity-100 motion-reduce:transition-none"
        >
          <span className="flex flex-col items-center gap-1">
            <Camera size={22} aria-hidden="true" />
            <span className="text-[11px] font-medium">{pending ? "Uploading…" : "Change"}</span>
          </span>
        </button>

        <input
          ref={inputRef}
          type="file"
          // JPEG only, and the server checks the file's first bytes rather than
          // trusting this - see saveAvatarFile. This attribute is a convenience
          // for the file picker, not a control.
          accept="image/jpeg,.jpg,.jpeg"
          className="hidden"
          onChange={(e) => {
            onPick(e.target.files?.[0]);
            // Cleared so picking the same file twice still fires a change.
            e.target.value = "";
          }}
        />
      </div>

      {/* Only once there is something to remove. Without this a photo is a
          one-way door: the crest is the default picture, so getting back to it
          has to be possible. */}
      {photo && (
        <button
          type="button"
          onClick={onRemove}
          disabled={pending}
          className="mt-2 block text-xs text-warmgray-500 underline-offset-2 hover:text-brand-900 hover:underline disabled:opacity-50"
        >
          Use my school crest
        </button>
      )}

      {error && (
        <p role="alert" className="mt-2 max-w-32 text-xs text-error-600">
          {error}
        </p>
      )}
    </div>
  );
}
