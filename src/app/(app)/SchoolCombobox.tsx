"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * A school picker that renders its own dropdown.
 *
 * Replaces a native <datalist>, which cannot be styled at all: the browser
 * draws that list with its own chrome, at its own width and in its own font,
 * so it never lined up with the field above it. The only way to get a dropdown
 * that matches the input is to draw it.
 *
 * Filtering happens here rather than on the server because the list is already
 * on the client for the field to work offline of a round trip per keystroke -
 * and at ~2,500 names a substring scan per keystroke is not something a person
 * can perceive.
 */
const MAX_VISIBLE = 50;

export default function SchoolCombobox({
  name,
  value,
  onChange,
  schools,
  readOnly,
  className,
  idName,
  options,
  placeholder,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  schools: string[];
  readOnly?: boolean;
  className?: string;
  /**
   * When set, the matched school's ID is posted under this name as well.
   *
   * Onboarding stores `claimedSchoolId`, not a typed name - so the field a
   * student sees is the school's name and the field the form submits is its
   * id. Left off, this is a plain text field, which is what the profile wants.
   */
  idName?: string;
  /** Needed only alongside `idName`, to resolve the typed name back to an id. */
  options?: { id: string; name: string }[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return schools.slice(0, MAX_VISIBLE);
    const starts: string[] = [];
    const contains: string[] = [];
    for (const s of schools) {
      const i = s.toLowerCase().indexOf(q);
      if (i === 0) starts.push(s);
      else if (i > 0) contains.push(s);
      // Ranked rather than merely filtered: typing "col" should reach Colby
      // and Colgate before "University of the Virgin Islands-College of
      // Nursing", which also contains it.
      if (starts.length >= MAX_VISIBLE) break;
    }
    return [...starts, ...contains].slice(0, MAX_VISIBLE);
  }, [value, schools]);

  // Reset the highlight when the query changes, adjusted DURING render rather
  // than in an effect. An effect that sets state runs after a commit, so the
  // list would paint once with the previous row highlighted and then again
  // without it - and it is the pattern React explicitly points away from.
  const [activeFor, setActiveFor] = useState(value);
  if (activeFor !== value) {
    setActiveFor(value);
    setActive(0);
  }

  // Close when focus or a click leaves the field entirely. Checking
  // containment rather than listening for blur, because moving from the input
  // to an option is a blur and must not dismiss the list mid-click.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("focusin", away);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("focusin", away);
    };
  }, [open]);

  // Keep the highlighted option in view when arrowing past the visible edge.
  useEffect(() => {
    if (!open) return;
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(school: string) {
    onChange(school);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (readOnly) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + delta + matches.length) % Math.max(1, matches.length));
    } else if (e.key === "Enter" && open && matches[active]) {
      // Only swallow Enter when it is choosing something. Otherwise it should
      // submit the form, which is what someone who has finished typing means.
      e.preventDefault();
      choose(matches[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    // relative so the list can be positioned against the input rather than the
    // page, which is what keeps it directly below and exactly as wide.
    <div ref={wrapRef} className="relative">
      {idName && (
        // Empty until the typed name matches a real school exactly. A partial
        // or unrecognised name posts no id rather than a wrong one, so the
        // server never records a school the student did not pick.
        <input
          type="hidden"
          name={idName}
          value={options?.find((o) => o.name.toLowerCase() === value.trim().toLowerCase())?.id ?? ""}
        />
      )}
      <input
        id={name}
        name={name}
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => !readOnly && setOpen(true)}
        onKeyDown={onKeyDown}
        className={className}
      />

      {open && !readOnly && matches.length > 0 && (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          // inset-x-0 is what makes it the same width as the input; top-full
          // puts it directly beneath. Font is inherited from the field rather
          // than restated, so the two cannot drift apart.
          className="combobox-list absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto py-1 text-sm"
        >
          {matches.map((s, i) => (
            <li
              // Index, not the name. Two institutions can share a name - see
              // the state suffix in the generator - and a duplicate React key
              // makes the list drop or duplicate rows.
              key={`${s}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // onMouseDown, not onClick: mousedown fires before the input's
              // blur, so the option is chosen instead of the list closing out
              // from under the pointer.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-1.5 ${i === active ? "is-active" : ""}`}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
