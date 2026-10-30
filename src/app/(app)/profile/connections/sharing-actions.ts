"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/current-user";
import { setFirmSharing } from "@/lib/firm-sharing";
import { setTrainingChoice } from "@/lib/training-consent";

/**
 * Turn sharing with firms on or off from Settings. Only ever the signed-in
 * student's own row, and off takes effect on every firm's next page load -
 * see lib/firm-sharing.ts.
 */
export async function setFirmSharingAction(formData: FormData) {
  const user = await getCurrentUser();
  await setFirmSharing(user.id, formData.get("shareWithFirms") === "on", "settings");
  revalidatePath("/profile/connections");
}

/**
 * Turn Training Use on or off from Settings. Off also deletes the student's
 * captured examples and sent-email archive - see lib/training-consent.ts.
 */
export async function setTrainingChoiceAction(formData: FormData) {
  const user = await getCurrentUser();
  await setTrainingChoice(user.id, formData.get("trainingOptIn") === "on", "settings", user.email);
  revalidatePath("/profile/connections");
}
