import { ArrowRight } from "lucide-react";

// The "Open" affordance shared by every panel in the home stack. Reads its
// interactive state entirely off the ancestor `<Link>`'s `group` class
// rather than carrying any of its own - every panel here is one giant link,
// this is just its visible corner. Filling solid on hover (not just a color
// change) is what makes it read as a real action rather than a caption;
// bg-accent-500/text-white is the same primary-button convention used
// everywhere else in the app, so this needed no new colors of its own.
export default function OpenTag() {
  return (
    <span className="mb-1.5 inline-flex shrink-0 items-center gap-1.5 border border-brand-100 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-warmgray-500 transition-colors duration-200 group-hover:border-accent-500 group-hover:bg-accent-500 group-hover:text-white">
      Open
      <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-1" />
    </span>
  );
}
