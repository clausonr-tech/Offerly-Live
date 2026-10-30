import SectionTopBar from "../SectionTopBar";
import { requirePaidAccess } from "@/lib/plan-access";

/** External Network's tabs - Dashboard and Industry Contacts - across the top. */
export default async function ExternalNetworkLayout({ children }: { children: React.ReactNode }) {
  await requirePaidAccess();
  return (
    <div>
      <SectionTopBar sectionHref="/dashboard" hubLabel="Dashboard" />
      {children}
    </div>
  );
}
