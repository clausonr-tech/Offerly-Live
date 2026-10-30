// Which resume files can be uploaded, and which can be read.
//
// One list, shared by the upload fields (client) and the storage and reading
// code (server), so a type accepted in a form is always one the server takes.

/** Everything a student can upload as their resume. */
const RESUME_EXTENSIONS = [".pdf", ".docx", ".doc", ".png", ".jpg", ".jpeg", ".webp", ".txt"] as const;

/**
 * What the resume reader understands. PDFs and images go to the model as they
 * are; .docx and .txt as text. Legacy binary .doc can be attached to emails
 * but not read.
 */
const READABLE_EXTENSIONS: readonly string[] = [".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".txt"];

/** For a file input's `accept`. */
export const RESUME_ACCEPT = RESUME_EXTENSIONS.join(",");

export const RESUME_TYPES_LABEL = "PDF, Word (.docx), image (PNG, JPG, WebP) or text file";

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export function isAllowedResume(name: string): boolean {
  return (RESUME_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

export function isReadableResume(name: string): boolean {
  return READABLE_EXTENSIONS.includes(extensionOf(name));
}
