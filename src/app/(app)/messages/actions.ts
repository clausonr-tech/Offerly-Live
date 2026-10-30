"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/current-user";
import { editMessage, sendMessage } from "@/lib/people";

export type SendState = { error?: string } | undefined;

export async function send(
  recipientId: string,
  _prev: SendState,
  formData: FormData,
): Promise<SendState> {
  const blocked = blockedLanguageError([["Your message", formData.get("body")]]);
  if (blocked) return { error: blocked };
  const senderId = await getCurrentUserId();
  const result = await sendMessage(senderId, recipientId, String(formData.get("body") ?? ""));
  if (result.error) return { error: result.error };
  revalidatePath(`/messages/${recipientId}`);
  revalidatePath("/networking");
  return {};
}

export type EditState = { error?: string; ok?: boolean } | undefined;

/** Change one of your own messages, within 10 minutes of sending it. */
export async function edit(messageId: string, _prev: EditState, formData: FormData): Promise<EditState> {
  const blocked = blockedLanguageError([["Your message", formData.get("body")]]);
  if (blocked) return { error: blocked };
  const senderId = await getCurrentUserId();
  const result = await editMessage(senderId, messageId, String(formData.get("body") ?? ""));
  if (result.error) return { error: result.error };
  revalidatePath(`/messages/${result.recipientId}`);
  revalidatePath("/networking");
  return { ok: true };
}
