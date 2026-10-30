"use client";

import { useRef, useState } from "react";
import { useCrestTint } from "@/lib/use-crest-tint";
import { CREST_VERSION } from "@/lib/crest-version";

/**
 * An avatar that is a logo when we can resolve one and initials when we can't.
 *
 * Used for two different things on purpose: a student's school crest in the
 * feed, and a contact's firm logo in the contacts stack. Both are "an
 * institution stands in for the person", and the identity is the point - a
 * wall of initials gives a reader no reason to open anything, while a wall of
 * crests and firm marks is scannable at a glance.
 */
export default function LogoAvatar({
  domain,
  label,
  alt,
  initials,
  size = 40,
  fallback = "circle",
  plainClassName = "",
  shape = "circle",
  photoUrl = null,
}: {
  /** The institution's web/mail domain - the only input the logo needs. */
  domain: string | null;
  /** Institution name, for the fallback's title and the default alt text. */
  label: string | null;
  /** Overrides the alt text, e.g. "Yale University crest" vs "Evercore logo". */
  alt?: string;
  initials: string;
  size?: number;
  /** What to draw when there is no logo. "circle" is the initials disc, right
   *  for a person in the feed. "plain" is the bare letter with no disc around
   *  it, styled by `plainClassName` - what the contact cards use, so a firm with
   *  no mark on record reads as a card's rank rather than as a failed avatar.
   *  "none" renders nothing. */
  fallback?: "circle" | "plain" | "none";
  /** Classes for the "plain" fallback, so this component does not have to know
   *  anything about the surface it is sitting on. */
  plainClassName?: string;
  /** "circle" everywhere this component has been used so far. "square" is
   *  for a context that wants to read as a stamped seal rather than a social
   *  avatar. It carries no rounded-* class at all, so it stays square
   *  whatever the app's corner scale is. */
  shape?: "circle" | "square";
  /**
   * A photo that stands in front of the logo entirely.
   *
   * The crest is the DEFAULT picture, not the only one - a student who has
   * uploaded a photo should be themselves everywhere their name appears, not
   * only on their own profile page. Passed as a URL rather than a flag so this
   * component still knows nothing about where avatars live.
   */
  photoUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  // The crest's own border colour, for the space around it. Null until it has
  // been read (and for a mark we cannot sample), which is why the disc still
  // needs a sensible colour of its own underneath.
  const tint = useCrestTint(photoUrl ? null : domain);
  const checkedRef = useRef(false);

  // The favicon service answers a domain it has nothing indexed for with a
  // generic 16x16 globe rather than a 404, so a plain onError never fires and
  // every unknown school would render the same grey planet. Anything that
  // small is that placeholder. The callback ref is needed alongside onLoad
  // because for a cached image the native load event fires before React
  // hydrates, so onLoad alone never runs - the same trap FirmLogo documents.
  const check = (img: HTMLImageElement | null) => {
    if (!img || checkedRef.current) return;
    if (img.complete) {
      checkedRef.current = true;
      if (img.naturalWidth > 0 && img.naturalWidth <= 16) setFailed(true);
    }
  };

  const roundedClass = shape === "circle" ? "rounded-full" : "";

  // Checked before the logo and before the fallback: a photo is the most
  // specific thing we have about a person, so nothing below can pre-empt it.
  if (photoUrl) {
    return (
      // Served by our own route, which already sets an immutable cache header:
      // the optimiser has nothing to add here and would proxy an authenticated
      // response through itself.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        alt={alt ?? `${label ?? "Profile"} photo`}
        width={size}
        height={size}
        className={`${roundedClass} object-cover`}
        style={{ width: size, height: size }}
      />
    );
  }

  if (!domain || failed) {
    if (fallback === "none") return null;
    if (fallback === "plain") {
      return (
        <span title={label ?? undefined} className={plainClassName} style={{ fontSize: size }}>
          {initials}
        </span>
      );
    }
    return (
      <span
        title={label ?? undefined}
        className={`flex shrink-0 items-center justify-center ${roundedClass} bg-brand-50 font-mono text-xs font-semibold text-brand-900 ring-1 ring-brand-100`}
        style={{ width: size, height: size, fontSize: Math.max(10, size * 0.3) }}
      >
        {initials}
      </span>
    );
  }

  return (
    <span
      // Filled with the crest's own border colour once it has been read, so
      // the leftover space stops looking like leftover space - Penn's navy
      // runs to the edge of the disc, USC's gold does the same.
      //
      // The fallback is bg-[#ffffff] and never bg-white: this app's dark theme
      // redefines --color-white to #0a0a0a as a themed near-black surface
      // token, so `bg-white` computed to rgb(10,10,10) and the disc went black
      // - taking every dark crest with it. Crests are drawn for a light
      // ground, so white is the right floor in BOTH themes.
      className={`flex shrink-0 items-center justify-center overflow-hidden ${roundedClass} bg-[#ffffff] ring-1 ring-brand-100`}
      style={{ width: size, height: size, ...(tint ? { backgroundColor: tint } : null) }}
    >
      {/* Crests and firm marks are square-ish artwork, not photographs, so
          object-contain rather than cover.
          The inset is 12% of the avatar and proportional rather than a flat
          3px, because the frame is a CIRCLE and object-contain fits the image
          to the SQUARE the circle is inscribed in - so the corners and the top
          and bottom edges of the artwork fall outside the mask. Penn's shield
          has a flat top and a pointed bottom and lost both: it read as sitting
          too high. A square inscribed in a circle needs ~14.6% off each side
          to fit entirely; 12% clears every mark tested without shrinking them
          needlessly.
          It costs nothing visually for a tile-style logo like USC's, because
          the disc behind it is already filled with that logo's own border
          colour - the padding is gold on gold. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={check}
        // Proxied, so the pixels the tint is read from are the pixels shown.
        src={`/api/crest?domain=${encodeURIComponent(domain)}&sz=256&v=${CREST_VERSION}`}
        alt={alt ?? (label ? `${label} logo` : "")}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-contain"
        style={{ padding: Math.max(2, Math.round(size * 0.12)) }}
        onError={() => setFailed(true)}
        onLoad={(e) => {
          checkedRef.current = true;
          if (e.currentTarget.naturalWidth > 0 && e.currentTarget.naturalWidth <= 16) setFailed(true);
        }}
      />
    </span>
  );
}
