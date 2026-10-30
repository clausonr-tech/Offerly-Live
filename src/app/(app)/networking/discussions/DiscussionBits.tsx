import { formatDistanceToNowStrict } from "date-fns";
import { EyeOff } from "lucide-react";

/** Who, and when - with the anonymous mark. */
export function Byline({
  author,
  anonymous,
  at,
}: {
  author: string;
  anonymous: boolean;
  at: Date;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-warmgray-500">
      {anonymous && <EyeOff size={12} aria-hidden />}
      <span className={anonymous ? "italic" : ""}>{author}</span>
      <span aria-hidden>·</span>
      <time dateTime={at.toISOString()}>{formatDistanceToNowStrict(at, { addSuffix: true })}</time>
    </p>
  );
}

export function TopicTag({ topic }: { topic: string }) {
  return (
    <span className="rounded-sm bg-accent-50 px-1.5 py-0.5 text-[11px] font-medium text-accent-600">{topic}</span>
  );
}
