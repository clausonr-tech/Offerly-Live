"use server";

import { HelpLimitError } from "@/lib/ai-runner";
import { blockedLanguageError, findBlockedLanguage } from "@/lib/content-limits";
import { getCurrentUser } from "@/lib/current-user";
import { getHelpReply } from "@/lib/help-assistant";
import { helpLanguageFields, validateHelpHistory } from "@/lib/help-chat-rules";

export type HelpAnswer = { reply: string } | { error: string; limited?: boolean };

const SNAG = "Oops, I hit a snag answering that one. Mind trying again in a moment?";
const BLOCKED_REPLY = "I tripped over my words on that one! Could you ask it another way?";

/**
 * One question to the Help assistant, with the conversation so far.
 *
 * Order matters: who is asking, a well-formed conversation, the language
 * check (project rule, CLAUDE.md) on every message before any of it reaches
 * the model, then the assistant's own limits inside the runner, then the
 * call - and the language check again on what comes back.
 */
export async function askHelpAssistant(history: unknown): Promise<HelpAnswer> {
  const user = await getCurrentUser();

  const checked = validateHelpHistory(history);
  if (!checked.ok) return { error: checked.error };

  // Every message, not just the newest - see helpLanguageFields.
  const blocked = blockedLanguageError(helpLanguageFields(checked.messages));
  if (blocked) return { error: blocked };

  try {
    const reply = await getHelpReply(checked.messages, {
      id: user.id,
      name: user.name,
      school: user.school,
      gradYear: user.gradYear,
      targetGroup: user.targetGroup,
      plan: user.plan,
    });
    if (findBlockedLanguage(reply)) return { error: BLOCKED_REPLY };
    return { reply };
  } catch (err) {
    if (err instanceof HelpLimitError) return { error: err.message, limited: true };
    console.error("[help assistant]", err);
    return { error: SNAG };
  }
}
