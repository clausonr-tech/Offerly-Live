"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/current-user";
import { setFirmPostEmails } from "@/lib/firm-post-emails";

/** Turns "email me when a firm I match with posts" on or off. */
export async function setFirmPostEmailsAction(form: FormData): Promise<void> {
  const user = await getCurrentUser();
  await setFirmPostEmails(user.id, String(form.get("on") ?? "") === "true");
  revalidatePath("/profile/connections");
}
