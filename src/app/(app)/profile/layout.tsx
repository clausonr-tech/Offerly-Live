import ProfileTabs from "./ProfileTabs";

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-2xl font-semibold text-brand-900">Your profile</h1>
      <ProfileTabs />
      <div className="mt-6">{children}</div>
    </div>
  );
}
