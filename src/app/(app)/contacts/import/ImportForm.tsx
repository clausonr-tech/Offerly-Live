"use client";

import { useActionState, useState } from "react";
import CsvDropZone from "@/components/CsvDropZone";
import { mapContactRow, normalizeDate, parseCsvText, type ParsedContactRow } from "@/lib/csv-import";
import { bulkImportContacts, type ActionState } from "./actions";

export default function ImportForm() {
  const [rows, setRows] = useState<ParsedContactRow[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    bulkImportContacts,
    undefined,
  );

  function handleFile(file: File) {
    setFileName(file.name);
    setParseError("");
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseCsvText(String(reader.result ?? ""), (row, headers) => {
        const m = mapContactRow(row, headers);
        return m ? { ...m, lastContactDate: normalizeDate(m.lastContactDate) } : null;
      });
      if (!parsed.ok) {
        setParseError(parsed.error);
        setRows([]);
        return;
      }
      setRows(parsed.rows);
      setSkipped(parsed.skipped);
    };
    reader.readAsText(file);
  }

  return (
    <div className="space-y-6">
      <CsvDropZone onFile={handleFile} onReject={setParseError} parseError={parseError}>
        <p className="mt-2 text-xs text-warmgray-500">
          Works with a LinkedIn connections export (Settings → Data privacy → Get a copy of your
          data → Connections) or any CSV with name/company/role/email columns.
        </p>
      </CsvDropZone>

      {rows.length > 0 && (
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="rows" value={JSON.stringify(rows)} />
          <div className="flex items-center justify-between">
            <p className="text-sm text-warmgray-600">
              <span className="font-semibold text-brand-900">{rows.length}</span> contact
              {rows.length === 1 ? "" : "s"} ready to import from {fileName}
              {skipped > 0 && (
                <span className="text-warmgray-500"> · {skipped} row{skipped === 1 ? "" : "s"} skipped (no name found)</span>
              )}
            </p>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-400 disabled:opacity-60 shadow-card"
            >
              {pending ? "Importing..." : `Import ${rows.length} contact${rows.length === 1 ? "" : "s"}`}
            </button>
          </div>

          <div className="max-h-96 overflow-auto rounded-lg border border-brand-100 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 border-b border-brand-100 bg-brand-50 text-xs uppercase tracking-wide text-warmgray-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Firm</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-100">
                {rows.slice(0, 25).map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-brand-900">{r.name}</td>
                    <td className="px-3 py-2 text-warmgray-600">{r.firm || "-"}</td>
                    <td className="px-3 py-2 text-warmgray-600">{r.role || "-"}</td>
                    <td className="px-3 py-2 text-warmgray-600">{r.email || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 25 && (
              <p className="border-t border-brand-100 px-3 py-2 text-xs text-warmgray-500">
                + {rows.length - 25} more
              </p>
            )}
          </div>

          {state?.error && <p className="text-sm text-error-600">{state.error}</p>}
        </form>
      )}
    </div>
  );
}
