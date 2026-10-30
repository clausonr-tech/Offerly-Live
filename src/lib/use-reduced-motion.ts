"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const getSnapshot = () => window.matchMedia(QUERY).matches;
// The server cannot know the preference, so it renders the animated branch and
// the client corrects on hydration - same assumption the components made before
// this hook existed, just without a setState in an effect body to get there.
const getServerSnapshot = () => false;

// Reads prefers-reduced-motion during render, so components can branch on it
// without a cascading re-render (and without tripping react-hooks/set-state-in-effect).
export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
