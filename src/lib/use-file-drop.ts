"use client";

import { useCallback, useRef, useState } from "react";

// Drag-and-drop for the file uploads across the app.
//
// Three details this exists to get right, because each one is a bug when it is
// missed and every upload site would otherwise have to remember it:
//
// 1. `dragenter`/`dragleave` fire for every child element the pointer crosses,
//    so a naive boolean flickers the highlight off as soon as the cursor moves
//    over the text inside the zone. A depth counter tracks enter/leave pairs
//    instead, and only the outermost leave clears the state.
//
// 2. `dragover` MUST call preventDefault. Without it the browser takes the drop
//    as a navigation and replaces the page with the file - losing whatever the
//    student had typed.
//
// 3. The dropped file is checked against the same `accept` string the file
//    input uses. The picker filters by it; a drop does not, so without this a
//    student can drop a .docx onto a PDF-only zone and get a confusing failure
//    from the server instead of an answer here.

/** Does `file` satisfy an `accept` attribute? Empty/absent accept allows all. */
function matchesAccept(file: File, accept?: string): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => {
      if (token.startsWith(".")) return name.endsWith(token);
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
      // A file dragged from some sources arrives with an empty `type`; fall
      // back to the extension rather than rejecting a legitimate file.
      return type ? type === token : false;
    });
}

/**
 * Puts `file` into a native `<input type="file">` so an ordinary form submit
 * carries it, and fires `change` so React and the browser's own "no file
 * chosen" label both update.
 *
 * DataTransfer is the only way to write to `input.files` - the property is
 * otherwise read-only.
 */
export function assignFileToInput(input: HTMLInputElement | null, file: File): void {
  if (!input) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export type FileDropOptions = {
  /** Same string as the file input's `accept`. */
  accept?: string;
  /** Called with the dropped file once it passes the accept check. */
  onFile: (file: File) => void;
  /** Called instead of onFile when the drop is rejected, with a reason. */
  onReject?: (reason: string) => void;
  disabled?: boolean;
};

export function useFileDrop({ accept, onFile, onReject, disabled }: FileDropOptions) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      depth.current -= 1;
      if (depth.current <= 0) reset();
    },
    [disabled, reset],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      // Required: without it the browser navigates to the dropped file.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [disabled],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      reset();
      // Every upload in this app takes exactly one file, so extra files in the
      // drop are ignored rather than silently overwriting each other.
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      if (!matchesAccept(file, accept)) {
        onReject?.(`${file.name} isn't a supported file type here.`);
        return;
      }
      onFile(file);
    },
    [accept, disabled, onFile, onReject, reset],
  );

  return {
    dragging,
    dropProps: { onDragEnter, onDragLeave, onDragOver, onDrop },
  };
}
