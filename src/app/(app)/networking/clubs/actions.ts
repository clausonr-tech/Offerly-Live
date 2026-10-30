"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUserId } from "@/lib/current-user";
import { addMemberAsPresident, leaveClub, removeMemberAsPresident, searchStudentsToAdd } from "@/lib/clubs";

const UUID = /^[0-9a-f-]{36}$/i;

function refresh(slug: string) {
  revalidatePath(`/networking/clubs/${slug}`);
  revalidatePath("/networking/clubs");
}

/** A member taking themselves out. The only membership change a non-officer can make. */
export async function leaveClubAction(input: { clubId: string; slug: string }): Promise<void> {
  const userId = await getCurrentUserId();
  if (!UUID.test(input.clubId)) return;
  await leaveClub(userId, input.clubId);
  refresh(input.slug);
}

/** Students the president could add. Refused for anyone who is not. */
export async function searchStudentsAction(input: { clubId: string; query: string }) {
  const userId = await getCurrentUserId();
  if (!UUID.test(input.clubId)) return [];
  return searchStudentsToAdd(userId, input.clubId, input.query);
}

export async function addMemberAction(input: { clubId: string; slug: string; userId: string }): Promise<{ error?: string }> {
  const viewerId = await getCurrentUserId();
  if (!UUID.test(input.clubId) || !UUID.test(input.userId)) return { error: "Couldn't add that student." };
  const ok = await addMemberAsPresident(viewerId, input.clubId, input.userId);
  if (!ok) return { error: "Only the club president can add members." };
  refresh(input.slug);
  return {};
}

export async function removeMemberAction(input: { clubId: string; slug: string; userId: string }): Promise<{ error?: string }> {
  const viewerId = await getCurrentUserId();
  if (!UUID.test(input.clubId) || !UUID.test(input.userId)) return { error: "Couldn't remove that member." };
  const ok = await removeMemberAsPresident(viewerId, input.clubId, input.userId);
  if (!ok) return { error: "Only the club president can remove members." };
  refresh(input.slug);
  return {};
}
