"use client";

import { useMemo, useState } from "react";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";

export type PickerContact = {
  id: string;
  name: string;
  role: string | null;
  firmKey: string;
  firmName: string;
  /** Sectors the contact's firm recruits for; empty when the firm is unknown. */
  divisions: string[];
};

const NO_DIVISION = "__none";

/**
 * A select with its own label.
 *
 * Module scope on purpose: declared inside the component it would be a new
 * component type on every render, and React would unmount and remount the
 * select underneath it - losing focus and the open dropdown mid-choice.
 */
function Labelled({
  text,
  show,
  children,
}: {
  text: string;
  show: boolean;
  children: React.ReactNode;
}) {
  if (!show) return <>{children}</>;
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-brand-900">{text}</span>
      {children}
    </label>
  );
}

/**
 * Company, then division, then person.
 *
 * A flat select of every contact is unusable past a hundred rows, and the two
 * steps before the name are the ones a student actually thinks in - "someone at
 * Evercore, in banking". Shared rather than reimplemented per form so the three
 * places that pick a contact behave identically.
 *
 * Submits a single `contactId` from the third select, so it drops into an
 * existing form without changing what the server reads.
 */
export default function ContactPicker({
  contacts,
  name = "contactId",
  required,
  allowNone,
  noneLabel = "No linked contact",
  onSelect,
  className = "grid gap-3 sm:grid-cols-3",
  showLabels = true,
}: {
  contacts: PickerContact[];
  name?: string;
  required?: boolean;
  /** Lets the field be left empty, for forms where a contact is optional. */
  allowNone?: boolean;
  noneLabel?: string;
  onSelect?: (id: string) => void;
  className?: string;
  /** Visible labels above each step. Off only where space forbids it. */
  showLabels?: boolean;
}) {
  const [firmKey, setFirmKey] = useState("");
  const [division, setDivision] = useState("");
  const [contactId, setContactId] = useState("");

  const selectClass =
    "w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none disabled:opacity-50";

  const companies = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const c of contacts) byKey.set(c.firmKey, c.firmName);
    return [...byKey.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [contacts]);

  const atFirm = useMemo(
    () => contacts.filter((c) => c.firmKey === firmKey),
    [contacts, firmKey],
  );

  const divisions = useMemo(() => {
    const set = new Set<string>();
    for (const c of atFirm) {
      if (c.divisions.length === 0) set.add(NO_DIVISION);
      else for (const d of c.divisions) set.add(d);
    }
    const label = (d: string) => CATEGORY_LABELS[d as FirmProgramCategory] ?? d;
    return [...set].sort((a, b) =>
      // "Division not known" is a fallback, so it sorts last rather than
      // alphabetically into the middle of the real sectors.
      a === NO_DIVISION ? 1 : b === NO_DIVISION ? -1 : label(a).localeCompare(label(b)),
    );
  }, [atFirm]);

  const people = useMemo(
    () =>
      atFirm
        .filter((c) =>
          !division
            ? true
            : division === NO_DIVISION
              ? c.divisions.length === 0
              : c.divisions.includes(division),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [atFirm, division],
  );

  return (
    <div className={className}>
      <Labelled text="Company" show={showLabels}>
      <select
        aria-label="Company"
        value={firmKey}
        onChange={(e) => {
          // Clearing downstream is the point: a person left selected under a
          // company they do not work at is how the wrong person gets emailed.
          setFirmKey(e.target.value);
          setDivision("");
          setContactId("");
          onSelect?.("");
        }}
        className={selectClass}
      >
        <option value="">{allowNone ? noneLabel : "Choose a company"}</option>
        {companies.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      </Labelled>

      <Labelled text="Division" show={showLabels}>
      <select
        aria-label="Division"
        value={division}
        disabled={!firmKey}
        onChange={(e) => {
          setDivision(e.target.value);
          setContactId("");
          onSelect?.("");
        }}
        className={selectClass}
      >
        <option value="">{firmKey ? "All divisions" : "Choose a company first"}</option>
        {divisions.map((d) => (
          <option key={d} value={d}>
            {d === NO_DIVISION ? "Division not known" : (CATEGORY_LABELS[d as FirmProgramCategory] ?? d)}
          </option>
        ))}
      </select>
      </Labelled>

      <Labelled text="Person" show={showLabels}>
      <select
        name={name}
        aria-label="Contact"
        required={required}
        value={contactId}
        disabled={!firmKey}
        onChange={(e) => {
          setContactId(e.target.value);
          onSelect?.(e.target.value);
        }}
        className={selectClass}
      >
        <option value="" disabled={required}>
          {firmKey ? `Choose a person (${people.length})` : "Choose a company first"}
        </option>
        {people.map((c) => (
          <option key={c.id} value={c.id}>
            {c.role ? `${c.name} - ${c.role}` : c.name}
          </option>
        ))}
      </select>
      </Labelled>
    </div>
  );
}
