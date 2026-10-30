"use client";

import { useEffect, useState } from "react";
import { CREST_VERSION } from "@/lib/crest-version";

/**
 * The colour to fill the disc behind a crest with: the crest's own border,
 * for crests that are full-bleed tiles. Null (a white disc) for everything
 * with transparent margins - see the edge check in sample().
 *
 * Penn's shield is outlined in navy, USC's tile is a field of gold, Harvard's
 * mark is crimson. Painting the leftover space in that colour makes the avatar
 * read as one object instead of artwork floating on a white circle.
 *
 * Sampled from the image rather than stored per school. A colour column would
 * be 2,571 values to fill in and keep true as schools rebrand, for something
 * that is already in the pixels we are about to draw.
 */

/** Resolved tints, shared across every avatar on the page. A feed is mostly
 *  the same handful of schools, so this turns N canvas reads into one per
 *  school for the life of the tab. */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Small enough to be instant, big enough that the border survives it. */
const SAMPLE = 64;
/** How far in from the edge counts as "the border", as a share of the mark. */
const RING = 0.14;

async function sample(domain: string): Promise<string | null> {
  const img = new Image();
  // Through our own proxy, not the favicon service directly: a cross-origin
  // image taints the canvas and getImageData then throws, so the pixels would
  // be unreadable. See app/api/crest.
  img.src = `/api/crest?domain=${encodeURIComponent(domain)}&sz=256&v=${CREST_VERSION}`;
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("crest failed to load"));
    });
  } catch {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  } catch {
    return null; // tainted despite the proxy - give up rather than guess
  }

  // Only a full-bleed tile gets a tinted disc - USC's field of gold, BU's
  // red square. A mark with transparent margins (a round seal, a shield) sits
  // on white: tinting its disc with its own outline colour buried NYU's purple
  // seal in a purple circle.
  let edge = 0, opaque = 0, paper = 0;
  for (let k = 0; k < SAMPLE; k++) {
    for (const [x, y] of [[k, 0], [k, SAMPLE - 1], [0, k], [SAMPLE - 1, k]]) {
      const i = (y * SAMPLE + x) * 4;
      edge++;
      if (data[i + 3] > 200) opaque++;
      if (data[i + 3] > 200 && Math.min(data[i], data[i + 1], data[i + 2]) > 235) paper++;
    }
  }
  if (opaque / edge < 0.9) return null;
  // A tile whose field is white (UT Austin's orange shield on white) is on a
  // white disc too - its ink colour belongs to the mark, not the background.
  if (paper / edge > 0.6) return null;

  // The mark's own bounding box, so a logo with transparent margins is
  // measured at its edge and not at the edge of the file.
  let minX = SAMPLE, maxX = -1, minY = SAMPLE, maxY = -1;
  for (let y = 0; y < SAMPLE; y++) {
    for (let x = 0; x < SAMPLE; x++) {
      if (data[(y * SAMPLE + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const ring = Math.max(1, Math.round(Math.min(maxX - minX + 1, maxY - minY + 1) * RING));
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const onEdge = x < minX + ring || x > maxX - ring || y < minY + ring || y > maxY - ring;
      if (!onEdge) continue;
      const i = (y * SAMPLE + x) * 4;
      if (data[i + 3] < 200) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
      // Paper and ink are what the border sits between, not the border. Without
      // these two the answer is white for most crests and black for the rest.
      if (hi > 238 && lo > 238) continue;
      if (hi < 18) continue;
      // Quantised to 16 levels per channel so anti-aliased pixels along an
      // edge count as one colour rather than a hundred near-misses.
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n++; bucket.r += r; bucket.g += g; bucket.b += b;
      buckets.set(key, bucket);
    }
  }

  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) if (!best || bucket.n > best.n) best = bucket;
  if (!best) return null;

  // Averaged within the winning bucket, so the result is the real colour
  // rather than the quantised corner of it.
  return `rgb(${Math.round(best.r / best.n)}, ${Math.round(best.g / best.n)}, ${Math.round(best.b / best.n)})`;
}

export function useCrestTint(domain: string | null | undefined): string | null {
  const [tint, setTint] = useState<string | null>(() => (domain ? (cache.get(domain) ?? null) : null));

  // An already-sampled school is answered DURING render, not from an effect.
  // Reading the cache in an effect means a first paint on the old colour and a
  // second render to correct it - visible as a flash when scrolling a feed
  // past schools that were resolved seconds ago, and the pattern React points
  // away from.
  const [seen, setSeen] = useState(domain);
  if (seen !== domain) {
    setSeen(domain);
    setTint(domain ? (cache.get(domain) ?? null) : null);
  }

  useEffect(() => {
    // Only the uncached path needs an effect: everything below is async, so
    // no state is set synchronously in this body.
    if (!domain || cache.has(domain)) return;
    let live = true;
    // De-duplicated per domain: twelve feed rows from one school start one
    // read, not twelve.
    const pending = inflight.get(domain) ?? sample(domain).then((value) => {
      cache.set(domain, value);
      inflight.delete(domain);
      return value;
    });
    inflight.set(domain, pending);
    pending.then((value) => {
      if (live) setTint(value);
    });
    return () => {
      live = false;
    };
  }, [domain]);

  return tint;
}
