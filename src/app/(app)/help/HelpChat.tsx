"use client";

import Link from "next/link";
import { ArrowUp, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { HELP_MAX_CHARS, HELP_MAX_MESSAGES, HELP_STARTERS, helpGreeting, type HelpMessage } from "@/lib/help-chat-rules";
import { helpInlineLinks, parseHelpReply } from "@/lib/help-reply-format";
import { askHelpAssistant, type HelpAnswer } from "./help-actions";

type Line = {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** A question that was not answered (a limit, a blocked word, a snag). Shown, never resent. */
  unsent?: boolean;
  /** The assistant's note about why - styled as a note, not an answer. */
  note?: boolean;
};

// Colours that must hold in both themes are inline: the panel is white in the
// dark theme too (.list-panel), where text-brand-900 and bg-brand-900 flip and
// the panel's inherit rule outranks Tailwind's arbitrary-hex classes.
const NAVY = "#0b1526";
const USER_BUBBLE = { backgroundColor: NAVY, color: "#ffffff" } as const;
const ASSISTANT_BUBBLE = { backgroundColor: "rgba(11, 21, 38, 0.05)", color: NAVY } as const;
const NOTE_BUBBLE = { backgroundColor: "#fff7e6", color: "#6b4a10", border: "1px solid rgba(180, 120, 20, 0.25)" } as const;

// Message-bubble corners, written out because they are not one radius: round
// on every corner except the one nearest the speaker - the tail, the way a messaging
// app draws it - so who said what reads at a glance.
const MINE_SHAPE = { borderRadius: "18px 18px 6px 18px" } as const;
const THEIRS_SHAPE = { borderRadius: "18px 18px 18px 6px" } as const;

/**
 * The Help assistant: ask anything about Offerly or recruiting.
 *
 * Opens on a fixed greeting (no model call). One question at a time - send is
 * disabled while an answer is on its way, which is also what keeps a normal
 * student far from the server's per-minute limit. Answers arrive as short
 * bullet lists and render as real lists.
 */
export default function HelpChat({
  name,
  ask = askHelpAssistant,
  starters = HELP_STARTERS,
  greeting,
  subtitle = "Anything about Offerly or recruiting. Ask as many questions as you like.",
}: {
  name: string | null;
  /** The firm portal passes its own assistant; the student one by default. */
  ask?: (history: HelpMessage[]) => Promise<HelpAnswer>;
  starters?: readonly string[];
  greeting?: string;
  subtitle?: string;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest message in view - inside the panel, never scrolling the page.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, pending]);

  // The textarea grows with what is typed, up to about five lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const asked = lines.some((l) => l.role === "user");
  const tooLong = draft.trim().length > HELP_MAX_CHARS;

  async function send(text: string) {
    const question = text.trim();
    if (!question || pending || question.length > HELP_MAX_CHARS) return;

    const mine: Line = { id: nextId.current++, role: "user", content: question };
    const history = [...lines, mine]
      .filter((l) => !l.unsent && !l.note)
      .slice(-HELP_MAX_MESSAGES)
      .map(({ role, content }) => ({ role, content }));

    setLines((prev) => [...prev, mine]);
    setDraft("");
    setPending(true);
    try {
      const answer = await ask(history);
      setLines((prev) =>
        "reply" in answer
          ? [...prev, { id: nextId.current++, role: "assistant", content: answer.reply }]
          : [
              ...prev.map((l) => (l.id === mine.id ? { ...l, unsent: true } : l)),
              { id: nextId.current++, role: "assistant", content: answer.error, note: true },
            ],
      );
    } catch {
      setLines((prev) => [
        ...prev.map((l) => (l.id === mine.id ? { ...l, unsent: true } : l)),
        {
          id: nextId.current++,
          role: "assistant",
          content: "I couldn't reach the server just now. Check your connection and try again?",
          note: true,
        },
      ]);
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a new line; never mid-composition (IME).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }

  return (
    <section aria-labelledby="assistant-heading" className="list-panel mb-8 flex flex-col border border-brand-100">
      <header className="flex items-center gap-3 border-b border-brand-100 px-5 py-3.5">
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={USER_BUBBLE}
        >
          <Sparkles size={15} strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <h2 id="assistant-heading" className="text-base font-medium text-brand-900">
            Ask the assistant
          </h2>
          <p className="text-xs text-warmgray-500">{subtitle}</p>
        </div>
      </header>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation with the assistant"
        className="max-h-[26rem] min-h-[9rem] space-y-3 overflow-y-auto px-5 py-4"
      >
        <Bubble line={{ id: 0, role: "assistant", content: greeting ?? helpGreeting(name) }} />
        {lines.map((line) => (
          <Bubble key={line.id} line={line} />
        ))}
        {pending && (
          <div className="flex justify-start">
            <span
              role="status"
              aria-label="The assistant is typing"
              className="flex items-center gap-1 px-3.5 py-3"
              style={{ ...ASSISTANT_BUBBLE, ...THEIRS_SHAPE }}
            >
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="h-1.5 w-1.5 rounded-full motion-safe:animate-bounce"
                  style={{ backgroundColor: "rgba(11, 21, 38, 0.45)", animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
          </div>
        )}
      </div>

      {!asked && (
        <div className="flex flex-wrap gap-2 px-5 pb-3">
          {starters.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void send(q)}
              disabled={pending}
              className="rounded-full border border-brand-100 px-3 py-1 text-xs text-brand-900 transition-colors hover:bg-brand-50 disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={onSubmit} className="border-t border-brand-100 px-4 py-3">
        <div className="flex items-end gap-2">
          <label htmlFor="help-question" className="sr-only">
            Your question
          </label>
          <textarea
            id="help-question"
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask me anything..."
            className="min-h-[2.5rem] flex-1 resize-none rounded-xl border border-brand-100 bg-transparent px-3 py-2 text-sm text-brand-900 outline-none focus:border-brand-300"
          />
          <button
            type="submit"
            disabled={pending || !draft.trim() || tooLong}
            aria-label="Send question"
            title="Send (Enter)"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
            style={USER_BUBBLE}
          >
            <ArrowUp size={17} strokeWidth={2} />
          </button>
        </div>
        <p className="mt-1.5 flex justify-between gap-3 text-[11px] text-warmgray-500">
          <span>Enter to send, Shift+Enter for a new line</span>
          {draft.length > HELP_MAX_CHARS * 0.8 && (
            <span aria-live="polite" style={tooLong ? { color: "#b42318" } : undefined}>
              {draft.trim().length}/{HELP_MAX_CHARS}
            </span>
          )}
        </p>
      </form>
    </section>
  );
}

function Bubble({ line }: { line: Line }) {
  if (line.role === "user") {
    return (
      <div className="flex flex-col items-end">
        <p
          className="max-w-[80%] whitespace-pre-wrap break-words px-4 py-2 text-sm leading-relaxed shadow-[0_1px_2px_rgba(11,21,38,0.12)]"
          style={{ ...USER_BUBBLE, ...MINE_SHAPE, opacity: line.unsent ? 0.6 : 1 }}
        >
          {line.content}
        </p>
        {line.unsent && <span className="mt-0.5 text-[10px] text-warmgray-500">Not sent</span>}
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div
        className="max-w-[80%] space-y-1.5 break-words px-4 py-2.5 text-sm leading-relaxed"
        style={{ ...(line.note ? NOTE_BUBBLE : ASSISTANT_BUBBLE), ...THEIRS_SHAPE }}
      >
        {parseHelpReply(line.content).map((block, i) =>
          block.kind === "list" ? (
            <ul key={i} className="list-disc space-y-0.5 pl-4 marker:text-[#6b7a90]">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          ) : (
            <p key={i}>
              <Inline text={block.text} />
            </p>
          ),
        )}
      </div>
    </div>
  );
}

/** Reply text with each `"Page" (/path)` shown as a link on the page name. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {helpInlineLinks(text).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          <Link key={i} href={part.href} className="font-medium underline underline-offset-2">
            {part.label}
          </Link>
        ),
      )}
    </>
  );
}
