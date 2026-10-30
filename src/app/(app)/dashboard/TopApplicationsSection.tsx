import { Suspense } from "react";
import { getCurrentUser } from "@/lib/current-user";
import { getTopMatchedPostings } from "@/lib/internship-postings";
import { internshipYearFor } from "@/lib/internship-year";
import TopApplications from "./TopApplications";

// Top applications behind their own Suspense boundary: scoring every open
// posting against the student's profile is the page's second-heaviest read,
// and the Today list beside it has no reason to wait for it.

async function Content() {
  const user = await getCurrentUser();
  const rows = await getTopMatchedPostings({ ...user, internshipYear: internshipYearFor(user) });
  return <TopApplications rows={rows} />;
}

function Skeleton() {
  return (
    <div
      className="list-panel h-40 animate-pulse border border-brand-100 bg-brand-50/60"
      aria-busy="true"
      aria-label="Loading top applications"
    />
  );
}

export default function TopApplicationsSection() {
  return (
    <Suspense fallback={<Skeleton />}>
      <Content />
    </Suspense>
  );
}
