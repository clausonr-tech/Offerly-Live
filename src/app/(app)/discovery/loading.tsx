// Discovery opens with the same navy hero as the dashboard, so paint that for
// real and pulse the match panels below it while the ranked tree is queried.
export default function DiscoveryLoading() {
  return (
    <div aria-busy="true" aria-label="Loading discovery">
      <div className="mb-8 rounded-2xl bg-gradient-to-br from-[#0b1526] via-[#1b2f4d] to-[#33517a] px-6 py-5 shadow-[0_10px_30px_-12px_rgba(11,21,38,0.55)]">
        <div className="h-7 w-44 animate-pulse rounded bg-white/15" />
        <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-white/10" />
      </div>
      <div className="space-y-6">
        <div className="list-panel h-72 animate-pulse border border-brand-100 bg-brand-50/60" />
        <div className="list-panel h-72 animate-pulse border border-brand-100 bg-brand-50/60" />
      </div>
    </div>
  );
}
