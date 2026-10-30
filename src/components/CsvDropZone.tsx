"use client";

import { useFileDrop } from "@/lib/use-file-drop";

/**
 * The CSV import drop target shared by the applications and contacts
 * importers: a dashed box that takes a picked or dropped .csv and shows parse
 * errors inline. The caller owns the parsing; the hint describing what the
 * file should look like comes in as children.
 */
export default function CsvDropZone({
  onFile,
  onReject,
  parseError,
  children,
}: {
  onFile: (file: File) => void;
  onReject: (message: string) => void;
  parseError: string;
  children: React.ReactNode;
}) {
  const { dragging, dropProps } = useFileDrop({
    accept: ".csv,text/csv",
    onFile,
    onReject,
  });

  return (
    <div
      {...dropProps}
      className={`rounded-lg border border-dashed p-6 text-center transition-colors ${
        dragging ? "border-accent-500 bg-accent-50" : "border-brand-200 bg-white"
      }`}
    >
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
        className="text-sm"
      />
      <p className="mt-1.5 text-xs text-warmgray-500">or drag a CSV anywhere onto this box</p>
      {children}
      {parseError && <p className="mt-2 text-sm text-error-600">{parseError}</p>}
    </div>
  );
}
