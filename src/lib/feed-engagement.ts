// What both sides of the live feed's engagement need: the server actions that
// write reactions and comments, and the cards that draw them. Kept out of
// lib/activity, which is server-only - the emoji set and the comment limit
// have to reach the browser as well.

/** The reactions a student can leave on a feed row, in the order the picker
 *  shows them. A fixed set rather than any emoji: the server rejects anything
 *  not listed here, so the column only ever holds these. */
export const REACTION_EMOJIS = ["👍", "❤️", "🔥", "🎉", "👏", "😂", "💡", "😮"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

/** The longest comment. A reply under a post, not a second post. */
export const COMMENT_MAX = 500;

/** One emoji's tally on a row, and whether the viewer is part of it. */
export type ReactionSummary = { emoji: ReactionEmoji; count: number; mine: boolean };

export type FeedComment = {
  id: string;
  userId: string;
  name: string;
  school: string | null;
  photoUrl: string | null;
  body: string;
  createdAt: Date;
  isYou: boolean;
};

/** Reactions in picker order, so a row's chips never reshuffle as counts change. */
export function sortReactions(list: ReactionSummary[]): ReactionSummary[] {
  return [...list].sort((a, b) => REACTION_EMOJIS.indexOf(a.emoji) - REACTION_EMOJIS.indexOf(b.emoji));
}
