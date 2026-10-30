/**
 * An error written for the student. `retryable` says whether trying the same
 * thing again could work; `code` lets the page tell states apart without
 * parsing the message.
 */
export class VideoInterviewError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly code?: "storage_unconfigured" | "training_off" | "duplicate" | "already_stored" | "invalid" | "not_found" | "storage_failed",
  ) {
    super(message);
    this.name = "VideoInterviewError";
  }
}
