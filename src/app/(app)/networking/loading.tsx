// Inside the Networking shell (its layout and notice are already painted);
// this holds the feed column while posts and people are queried.
export default function NetworkingLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading networking">
      <div className="list-panel h-24 animate-pulse border border-brand-100 bg-brand-50/60" />
      <div className="list-panel h-80 animate-pulse border border-brand-100 bg-brand-50/60" />
    </div>
  );
}
