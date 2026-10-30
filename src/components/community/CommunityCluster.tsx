import { forwardRef } from "react";

import InitialsAvatar from "./InitialsAvatar";
import type { CommunityGroup } from "./data";

// A real <button>: the cluster is operable by mouse, touch and keyboard, and
// carries its own accessible name rather than relying on the visual grouping.
const CommunityCluster = forwardRef<
  HTMLButtonElement,
  { group: CommunityGroup; active: boolean; onSelect: () => void }
>(function CommunityCluster({ group, active, onSelect }, ref) {
  const Icon = group.icon;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      onFocus={onSelect}
      onMouseEnter={onSelect}
      aria-pressed={active}
      aria-label={`${group.label}. ${group.description} Example: ${group.activity}`}
      className={`group/cluster relative w-full max-w-[320px] cursor-pointer border p-4 text-left backdrop-blur-[3px] transition-[transform,border-color,background-color] duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7fb3dd] motion-reduce:transition-none md:w-[236px] ${
        active
          ? "-translate-y-1 border-white/25 bg-white/[0.07]"
          : "border-white/10 bg-white/[0.03] hover:border-white/20"
      }`}
    >
      {/* Soft radial glow behind the active cluster. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-px -z-10 transition-opacity duration-500 motion-reduce:transition-none"
        style={{
          opacity: active ? 1 : 0,
          background: `radial-gradient(70% 90% at 50% 40%, ${group.accent}2e, transparent 70%)`,
        }}
      />

      <span className="flex items-center gap-2.5">
        <span
          className="flex h-8 w-8 items-center justify-center border"
          style={{ borderColor: `${group.accent}59`, backgroundColor: `${group.accent}1f` }}
        >
          <Icon className="h-4 w-4" style={{ color: group.accent }} strokeWidth={1.75} />
        </span>

        <span className="text-[15px] font-medium text-white">{group.label}</span>

        {/* Status dot - "this group is active", not a fabricated member count. */}
        <span className="ml-auto flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: group.accent, boxShadow: `0 0 6px ${group.accent}` }}
          />
          <span className="text-[10px] uppercase tracking-[0.14em] text-white/45">Active</span>
        </span>
      </span>

      <span className="mt-3 flex items-center">
        <span className="flex items-center">
          {group.members.map((m, i) => (
            <span key={m.initials} className={i === 0 ? "" : "-ml-2.5"}>
              <InitialsAvatar initials={m.initials} tone={m.tone} />
            </span>
          ))}
        </span>
      </span>

      {/* Reserved for two lines, so a cluster whose activity line wraps is the
          same height as one whose does not. */}
      <span className="mt-3 block min-h-[34px] text-[12.5px] leading-snug text-white/70">
        <span className="line-clamp-2">{group.activity}</span>
      </span>

      {/* Message preview. Its space is reserved whether or not it is showing,
          so selecting a cluster never changes the panel's height - the beams
          stay attached and nothing in the constellation reflows. Every panel
          reserves the same block, so they all read as one family. */}
      <span className="mt-2.5 block h-[34px]">
        <span
          className={`block border-l-2 pl-2.5 text-[12.5px] italic leading-snug text-white/80 transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
            active ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
          }`}
          style={{ borderColor: `${group.accent}80` }}
        >
          <span className="line-clamp-2">&ldquo;{group.message}&rdquo;</span>
        </span>
      </span>

      {/* Reserved so a three-tag cluster that wraps to two rows is the same
          height as a two-tag one. */}
      <span className="mt-3 flex min-h-[50px] flex-wrap content-start gap-1.5">
        {group.tags.map((tag) => (
          <span
            key={tag}
            className="border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] tracking-wide text-white/60"
          >
            {tag}
          </span>
        ))}
      </span>

      <span
        className="mt-3 block text-[11px] font-medium tracking-wide transition-colors duration-300 motion-reduce:transition-none"
        style={{ color: active ? group.accent : "rgba(255,255,255,0.4)" }}
      >
        {group.actionLabel}
        <span className="text-white/30"> · demo</span>
      </span>
    </button>
  );
});

export default CommunityCluster;
