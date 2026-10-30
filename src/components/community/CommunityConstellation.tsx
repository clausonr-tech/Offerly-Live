"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

import AnimatedConnection, { type Point } from "./AnimatedConnection";
import CommunityCluster from "./CommunityCluster";
import InitialsAvatar from "./InitialsAvatar";
import { CENTRAL_USER, COMMUNITY_GROUPS, type GroupId } from "./data";

type Geometry = { width: number; height: number; center: Point; nodes: Partial<Record<GroupId, Point>> };

export default function CommunityConstellation() {
  const reducedMotion = usePrefersReducedMotion();
  const [selected, setSelected] = useState<GroupId>(COMMUNITY_GROUPS[0].id);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const clusterRefs = useRef<Partial<Record<GroupId, HTMLButtonElement | null>>>({});

  // Beam endpoints are measured from the DOM rather than hardcoded, so the
  // curves stay attached through every breakpoint change, font swap and
  // container resize - including the layout flip from the stacked mobile
  // column to the desktop constellation, which is done in CSS alone.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const box = container.getBoundingClientRect();
      const centerEl = centerRef.current;
      if (!centerEl || box.width === 0 || box.height === 0) return;

      const centreOf = (el: Element): Point => {
        const r = el.getBoundingClientRect();
        return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
      };

      const nodes: Partial<Record<GroupId, Point>> = {};
      for (const group of COMMUNITY_GROUPS) {
        const el = clusterRefs.current[group.id];
        if (el) nodes[group.id] = centreOf(el);
      }

      setGeometry({
        width: box.width,
        height: box.height,
        center: centreOf(centerEl),
        nodes,
      });
    };

    // Observing the children too: the message preview expands inside a cluster
    // when it is selected, which moves that cluster's centre.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (centerRef.current) observer.observe(centerRef.current);
    for (const group of COMMUNITY_GROUPS) {
      const el = clusterRefs.current[group.id];
      if (el) observer.observe(el);
    }

    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const setRef = useCallback(
    (id: GroupId) => (el: HTMLButtonElement | null) => {
      clusterRefs.current[id] = el;
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="relative mx-auto flex w-full max-w-[720px] flex-col items-center gap-4 md:block md:h-[760px] md:gap-0"
    >
      {/* Beams sit under the panels, so each curve is visually clipped by the
          node it runs to and no endpoint needs trimming. Decorative. */}
      {geometry && (
        <svg
          aria-hidden="true"
          focusable="false"
          className="pointer-events-none absolute inset-0 h-full w-full opacity-40 md:opacity-100"
          /* Softer on the stacked layout: there the beams run behind the
             panels rather than out to the corners, and at full strength
             they read through the glass instead of behind it. */
          width={geometry.width}
          height={geometry.height}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        >
          {COMMUNITY_GROUPS.map((group) => {
            const to = geometry.nodes[group.id];
            if (!to) return null;
            return (
              <AnimatedConnection
                key={group.id}
                group={group}
                from={geometry.center}
                to={to}
                active={selected === group.id}
                reducedMotion={reducedMotion}
              />
            );
          })}
        </svg>
      )}

      {/* Central node - the signed-in student. */}
      <div
        ref={centerRef}
        className="relative z-10 w-full max-w-[320px] border border-white/15 bg-white/[0.06] p-4 backdrop-blur-[3px] md:absolute md:left-1/2 md:top-1/2 md:w-[220px] md:-translate-x-1/2 md:-translate-y-1/2"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-8 -z-10"
          style={{
            background: "radial-gradient(50% 50% at 50% 50%, rgba(122,162,214,0.20), transparent 72%)",
          }}
        />

        <div className="flex items-center gap-3">
          <InitialsAvatar initials={CENTRAL_USER.initials} tone="steel" size="lg" />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[15px] font-medium text-white">
              <span className="truncate">{CENTRAL_USER.name}</span>
            </p>
            <p className="truncate text-[11.5px] text-white/55">{CENTRAL_USER.subtitle}</p>
          </div>
        </div>

        <span className="absolute right-3 top-3 border border-white/20 bg-white/10 px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.16em] text-white/70">
          {CENTRAL_USER.youLabel}
        </span>

        <div className="mt-3 border-t border-white/10 pt-2.5">
          <p className="text-[10px] uppercase tracking-[0.16em] text-white/40">Recruiting focus</p>
          <p className="mt-0.5 text-[12.5px] text-white/85">{CENTRAL_USER.focus}</p>
        </div>
      </div>

      {COMMUNITY_GROUPS.map((group) => (
        <div
          key={group.id}
          className={`relative z-10 flex w-full justify-center md:absolute md:w-[236px] md:-translate-x-1/2 md:-translate-y-1/2 ${group.positionClass}`}
        >
          <CommunityCluster
            ref={setRef(group.id)}
            group={group}
            active={selected === group.id}
            onSelect={() => setSelected(group.id)}
          />
        </div>
      ))}

      <style jsx>{`
        /* Travels the dash along the beam. Only stroke-dashoffset moves, so
           this never triggers layout or paint of anything else. */
        :global(.beam-flow) {
          animation: beam-flow 3.6s linear infinite;
        }

        @keyframes beam-flow {
          from {
            stroke-dashoffset: 135;
          }
          to {
            stroke-dashoffset: 0;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          :global(.beam-flow) {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
