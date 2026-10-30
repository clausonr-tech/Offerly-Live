import OfferlyLogo from "@/components/brand/OfferlyLogo";

// The Offerly logo in the app frame: the student rail and the firm portal.
//
// Both forms are rendered and CSS picks one (.app-logo-* in globals.css): the
// full wordmark in the open rail and the mobile header, the O-and-arrow mark
// alone once the rail collapses to its 46px row, where the wordmark would be
// too small to read. Choosing in CSS rather than from the collapsed state
// keeps it right on the first paint, before the rail's state has hydrated.
export default function Logo({ className }: { className?: string }) {
  return (
    <span className={`app-logo inline-flex items-center ${className ?? ""}`}>
      <OfferlyLogo variant="wordmark" className="app-logo-wordmark h-[1.75rem] w-auto" />
      <OfferlyLogo variant="mark" className="app-logo-mark h-[1.9rem] w-auto" />
    </span>
  );
}
