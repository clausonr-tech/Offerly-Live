"use client";

import { useEffect, useRef, useState } from "react";

import { CREST_VERSION } from "@/lib/crest-version";
import { logoDomain } from "@/lib/firm-logo-domain";

const logoUrl = (host: string) => `/api/crest?domain=${encodeURIComponent(host)}&sz=256&v=${CREST_VERSION}`;

/**
 * Whether a firm's logo is dark - black or navy ink on a transparent ground,
 * like Lazard's or PWP's - measured once per domain and remembered.
 *
 * Read through /api/crest - the same URL the logo itself is drawn from -
 * because a canvas refuses to be read after drawing a cross-origin image. Only the
 * pixels that are actually painted count: a logo on its own white square is
 * mostly white, reads light, and needs no tile. Anything that cannot be
 * measured is treated as not dark - it is shown exactly as before.
 */
const darkness = new Map<string, Promise<boolean>>();

function isDarkLogo(host: string): Promise<boolean> {
  let known = darkness.get(host);
  if (!known) {
    known = new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const n = 32;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = n;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(false);
          ctx.drawImage(img, 0, 0, n, n);
          const { data } = ctx.getImageData(0, 0, n, n);
          let painted = 0;
          let light = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            painted++;
            // Relative luminance, near enough for "is this ink dark".
            light += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          }
          resolve(painted > n * n * 0.05 && light / painted < 0.4);
        } catch {
          resolve(false);
        }
      };
      img.onerror = () => resolve(false);
      img.src = logoUrl(host);
    });
    darkness.set(host, known);
  }
  return known;
}

/**
 * A firm's logo, served from our own /api/crest.
 *
 * That route answers with the firm's own sharp logo when
 * scripts/find-firm-logos.ts found one (an SVG, a 180px apple-touch-icon, a
 * 512px manifest icon, the Wikidata logo), says "none" when the harvester
 * established there is no accurate one to show, and otherwise falls back to
 * Google's favicon. One source, same-origin: the darkness check below reads the
 * very pixels that are shown.
 *
 * It replaces a chain the browser walked itself - Google, icon.horse, the
 * site's apple-touch-icon, unavatar, DuckDuckGo - which ended on DuckDuckGo's
 * 16px icons, the blur this was meant to fix, and could not tell a firm with
 * no logo from a firm whose domain shows somebody else's (a LinkedIn page, an
 * acquirer's site).
 */
export default function FirmLogo({
  domain,
  name,
  size = 40,
  backDarkLogo = false,
}: {
  domain: string;
  name: string;
  size?: number;
  /**
   * On a dark surface: give a dark logo a white tile behind it. The tile is
   * drawn by the surface's CSS (.play-card .logo-backing), so it appears only
   * where the face is actually dark - not on the cream dark-theme card.
   */
  backDarkLogo?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const checkedRef = useRef(false);

  // Google's "no favicon indexed" answer is a generic 16x16 placeholder, so it
  // arrives as a successful load rather than an error. A callback ref is needed
  // as well as onLoad because for already-cached images the native load event
  // fires before React attaches the handler, so onLoad alone never runs.
  const checkImg = (img: HTMLImageElement | null) => {
    if (!img || checkedRef.current) return;
    if (img.complete) {
      checkedRef.current = true;
      if (tooSmall(img.naturalWidth)) setFailed(true);
    }
  };

  const host = logoDomain(domain);

  const [dark, setDark] = useState(false);
  useEffect(() => {
    if (!backDarkLogo || !host) return;
    let live = true;
    isDarkLogo(host).then((d) => live && setDark(d));
    return () => {
      live = false;
    };
  }, [backDarkLogo, host]);

  // What counts as too small depends on how big it will be drawn. A 32px icon
  // is fine in a 28px row and visibly soft at 64px, and the old flat "<= 16"
  // check passed both. Half the display size is the point where upscaling
  // starts to show. Never below 17, though: Google's placeholder globe is
  // exactly 16px, and at a small size (a 20px bell row) half would let it
  // through.
  const minAcceptable = Math.max(17, Math.floor(size / 2));
  // Zero is not small: it is an SVG logo with no intrinsic size, which is the
  // sharpest kind there is. A real failure arrives as onError instead.
  const tooSmall = (w: number) => w > 0 && w < minAcceptable;

  if (!host || failed) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-md bg-brand-100 font-semibold text-brand-700"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
        aria-label={`${name} logo unavailable`}
      >
        {name.trim().charAt(0).toUpperCase()}
      </div>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={checkImg}
      src={logoUrl(host)}
      alt={`${name} logo`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="shrink-0 object-contain"
      onError={() => setFailed(true)}
      onLoad={(e) => {
        checkedRef.current = true;
        if (tooSmall(e.currentTarget.naturalWidth)) setFailed(true);
      }}
    />
  );
  return dark ? <span className="logo-backing inline-flex shrink-0">{image}</span> : image;
}
