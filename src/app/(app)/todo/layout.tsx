import { requirePaidAccess } from "@/lib/plan-access";

/**
 * Plan gate only: this section is part of Offerly Pro (lib/plan-access), and
 * a layout covers every page beneath it, pages added later included. A free
 * account is sent to /upgrade before anything here renders.
 */
export default async function GatedLayout({ children }: { children: React.ReactNode }) {
  await requirePaidAccess();
  return children;
}
