"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUserId } from "@/lib/current-user";
import { addPeer, removePeer } from "@/lib/peers";

/**
 * Add someone as a peer, or drop your half of the pair.
 *
 * Takes only ids and a flag - no typed words reach it, which is why it is not
 * in the content-limit checks.
 */
export async function togglePeer(input: { peerId: string; peer: boolean }): Promise<void> {
  const viewerId = await getCurrentUserId();
  if (input.peer) {
    await removePeer(viewerId, input.peerId);
  } else {
    await addPeer(viewerId, input.peerId);
  }
  revalidatePath("/networking/peers");
  revalidatePath("/networking/connect");
  revalidatePath("/networking");
}
