"use client";

import { useEffect, useRef } from "react";

/** A scrolling pane that opens at its newest message, and follows new ones. */
export default function ScrollToEnd({ children, className, deps }: { children: React.ReactNode; className?: string; deps: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [deps]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
