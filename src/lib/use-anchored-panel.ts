import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * Shared mechanics of the top-bar dropdown panels (the notification bells and
 * help menus, student app and firm portal alike). Each hook's body was copied
 * verbatim between those four components before it lived here.
 */

/**
 * Nudges a right-anchored panel back inside a 16px viewport gutter.
 *
 * The panel hangs from its button's right edge, but the button is not at the
 * screen's right edge - the bell, theme toggle and account menu sit beyond
 * it. On a phone the panel is nearly as wide as the screen, so hanging it
 * from there put its left edge (and the start of every title) off-screen.
 */
export function useFitPanelInViewport(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    function fit() {
      if (!el) return;
      el.style.right = "0px";
      const left = el.getBoundingClientRect().left;
      if (left < 16) el.style.right = `${left - 16}px`;
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ref, open]);
}

/** Closes the panel on a click outside it or on Escape. */
export function useCloseOnOutsideOrEscape(
  ref: RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
    // Registered once, as the inline originals were: `close` only touches
    // stable state setters, so the first render's closure stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * The help menus' keyboard wiring: outside click and Escape close the panel,
 * and "?" opens it from anywhere - the convention most apps share - but never
 * while someone is typing, where a question mark is just a question mark.
 */
export function useHelpMenuShortcuts(
  ref: RefObject<HTMLElement | null>,
  close: () => void,
  openPanel: () => void,
) {
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
      if (e.key === "?" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        openPanel();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
    // Registered once, as the inline originals were: `close` and `openPanel`
    // only touch stable state setters, so the first render's closure stays
    // correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
