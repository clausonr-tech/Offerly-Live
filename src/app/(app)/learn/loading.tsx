// While Practice rounds loads its stats and leaderboard. The header and tabs
// come from learn/layout.tsx and are already on screen; this only holds the
// two panels' places, so nothing jumps when they land.
export default function LearnLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading practice rounds">
      <div className="list-panel h-80 animate-pulse border border-brand-100 bg-brand-50/60" />
      <div className="list-panel h-14 animate-pulse border border-brand-100 bg-brand-50/60" />
    </div>
  );
}
