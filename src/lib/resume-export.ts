import "server-only";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from "docx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { ResumeFormat, RevisedResume } from "./resume-rewrite";

// Two exporters over one structured resume.
//
// Both take their typography from the format the model read off the student's
// original PDF, rather than imposing a house style. A resume is a document
// somebody has already made choices about; handing it back in a different font
// makes it feel like someone else's.
//
// Word is the one students keep editing, so it names the real font and Word
// substitutes if the reader lacks it. The PDF is what gets attached to an
// application.

// Used for drafts written before formatting was captured, and as the floor for
// any field the model leaves out. Deliberately a plain banking-resume look.
const DEFAULT_FORMAT: ResumeFormat = {
  fontFamily: "Times New Roman",
  serif: true,
  bodySizePt: 10,
  nameSizePt: 16,
  headingSizePt: 11,
  marginPt: 54,
  nameAlign: "center",
  headingUppercase: true,
  headingRule: true,
  datesRightAligned: true,
  italicRole: false,
  italicDates: false,
  bulletChar: "•",
  lineSpacing: 1.15,
  changedFromOriginal: [],
};

function formatOf(resume: RevisedResume): ResumeFormat {
  const f = resume.format;
  if (!f) return DEFAULT_FORMAT;
  // Sizes arrive from a model reading a PDF, so they are clamped rather than
  // trusted: an 84pt body size would render one word per page.
  const clamp = (v: number | undefined, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    ...DEFAULT_FORMAT,
    ...f,
    bodySizePt: clamp(f.bodySizePt, 7, 14, DEFAULT_FORMAT.bodySizePt),
    nameSizePt: clamp(f.nameSizePt, 10, 30, DEFAULT_FORMAT.nameSizePt),
    headingSizePt: clamp(f.headingSizePt, 8, 18, DEFAULT_FORMAT.headingSizePt),
    marginPt: clamp(f.marginPt, 18, 108, DEFAULT_FORMAT.marginPt),
    lineSpacing: clamp(f.lineSpacing, 0.9, 2, DEFAULT_FORMAT.lineSpacing),
    bulletChar: f.bulletChar?.slice(0, 2) || DEFAULT_FORMAT.bulletChar,
  };
}

export function resumeFilename(name: string, ext: "docx" | "pdf"): string {
  const base = (name || "resume").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");
  return `${base || "resume"}_resume.${ext}`;
}

/* ------------------------------- Word --------------------------------- */

export async function resumeToDocx(resume: RevisedResume): Promise<Buffer> {
  const f = formatOf(resume);
  // docx sizes are half-points; margins are twips (20 per point).
  const half = (pt: number) => Math.round(pt * 2);
  const twip = (pt: number) => Math.round(pt * 20);
  const lineTwip = Math.round(f.bodySizePt * f.lineSpacing * 20);
  const contentTwip = twip(612 - f.marginPt * 2);

  const children: Paragraph[] = [
    new Paragraph({
      alignment: f.nameAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text: resume.name, bold: true, size: half(f.nameSizePt) })],
    }),
    new Paragraph({
      alignment: f.nameAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { after: 200 },
      children: [new TextRun({ text: resume.contact, size: half(f.bodySizePt) })],
    }),
  ];

  for (const section of resume.sections ?? []) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 80 },
        ...(f.headingRule
          ? { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000" } } }
          : {}),
        children: [
          new TextRun({
            text: f.headingUppercase ? section.heading.toUpperCase() : section.heading,
            bold: true,
            size: half(f.headingSizePt),
          }),
        ],
      }),
    );

    for (const entry of section.entries ?? []) {
      const org = entry.org?.trim();
      const role = entry.role?.trim();
      const meta = [entry.location, entry.dates].filter(Boolean).join(", ");

      if (org || role || meta) {
        const runs: TextRun[] = [];
        if (org) runs.push(new TextRun({ text: org, bold: true, size: half(f.bodySizePt) }));
        if (role) {
          runs.push(
            new TextRun({
              text: org ? ` — ${role}` : role,
              bold: !f.italicRole,
              italics: f.italicRole,
              size: half(f.bodySizePt),
            }),
          );
        }
        if (meta) {
          runs.push(
            new TextRun({
              // A right tab stop is what puts dates in their own column; without
              // it they trail the title and the eye has nothing to run down.
              text: f.datesRightAligned ? `\t${meta}` : `, ${meta}`,
              italics: f.italicDates,
              size: half(f.bodySizePt),
            }),
          );
        }
        children.push(
          new Paragraph({
            ...(f.datesRightAligned
              ? { tabStops: [{ type: TabStopType.RIGHT, position: contentTwip }] }
              : {}),
            spacing: { before: 120, line: lineTwip },
            children: runs,
          }),
        );
      }

      for (const bullet of entry.bullets ?? []) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40, line: lineTwip },
            children: [new TextRun({ text: bullet, size: half(f.bodySizePt) })],
          }),
        );
      }
    }
  }

  const doc = new Document({
    // Word takes the family by name and substitutes if the reader lacks it, so
    // this matches the original far more closely than the PDF can.
    styles: { default: { document: { run: { font: f.fontFamily } } } },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: twip(f.marginPt),
              bottom: twip(f.marginPt),
              left: twip(f.marginPt),
              right: twip(f.marginPt),
            },
          },
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

/* -------------------------------- PDF ---------------------------------- */

const PAGE = { w: 612, h: 792 }; // US Letter, points

export async function resumeToPdf(resume: RevisedResume): Promise<Buffer> {
  const f = formatOf(resume);
  const pdf = await PDFDocument.create();

  // pdf-lib ships only the standard 14 faces, so the original's family is
  // matched by class rather than by name: a serif resume gets Times, a sans one
  // Helvetica. Times New Roman and Arial land near-exactly; Calibri and
  // Garamond land close, which is the trade for not embedding font files.
  const faces = f.serif
    ? {
        regular: StandardFonts.TimesRoman,
        bold: StandardFonts.TimesRomanBold,
        italic: StandardFonts.TimesRomanItalic,
      }
    : {
        regular: StandardFonts.Helvetica,
        bold: StandardFonts.HelveticaBold,
        italic: StandardFonts.HelveticaOblique,
      };
  const regular = await pdf.embedFont(faces.regular);
  const bold = await pdf.embedFont(faces.bold);
  const italic = await pdf.embedFont(faces.italic);

  const MARGIN = f.marginPt;
  const body = f.bodySizePt;
  const lead = body * f.lineSpacing;

  let page = pdf.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - MARGIN;
  const right = PAGE.w - MARGIN;
  const width = right - MARGIN;

  // pdf-lib draws text; it does not lay it out. Everything below - wrapping,
  // page breaks, the right-aligned date column - is that missing layer.
  function room(need: number) {
    if (y - need < MARGIN) {
      page = pdf.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - MARGIN;
    }
  }

  function wrap(text: string, font: typeof regular, size: number, max: number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > max && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function draw(text: string, x: number, size: number, font: typeof regular) {
    page.drawText(text, { x, y, size, font, color: rgb(0.1, 0.1, 0.12) });
  }

  // Name
  room(f.nameSizePt + 6);
  const nameX =
    f.nameAlign === "center"
      ? (PAGE.w - bold.widthOfTextAtSize(resume.name, f.nameSizePt)) / 2
      : MARGIN;
  draw(resume.name, nameX, f.nameSizePt, bold);
  y -= f.nameSizePt + 4;

  room(body + 10);
  const contactX =
    f.nameAlign === "center"
      ? (PAGE.w - regular.widthOfTextAtSize(resume.contact, body)) / 2
      : MARGIN;
  draw(resume.contact, contactX, body, regular);
  y -= body + 12;

  for (const section of resume.sections ?? []) {
    room(f.headingSizePt + 14);
    draw(
      f.headingUppercase ? section.heading.toUpperCase() : section.heading,
      MARGIN,
      f.headingSizePt,
      bold,
    );
    y -= 4;
    if (f.headingRule) {
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: right, y },
        thickness: 0.6,
        color: rgb(0.1, 0.1, 0.12),
      });
    }
    y -= lead;

    for (const entry of section.entries ?? []) {
      const title = [entry.org, entry.role].filter(Boolean).join(" — ");
      const meta = [entry.location, entry.dates].filter(Boolean).join(", ");
      const metaFont = f.italicDates ? italic : regular;

      if (title || meta) {
        if (f.datesRightAligned) {
          // The date column is right-aligned, so the title is wrapped to what is
          // left of the line - otherwise a long title runs underneath the dates
          // and the two overprint.
          const metaW = meta ? metaFont.widthOfTextAtSize(meta, body) : 0;
          const titleLines = title ? wrap(title, bold, body, width - metaW - (metaW ? 12 : 0)) : [""];
          for (const [i, line] of titleLines.entries()) {
            room(lead + 2);
            if (line) draw(line, MARGIN, body, bold);
            if (i === 0 && meta) draw(meta, right - metaW, body, metaFont);
            y -= lead + 1;
          }
        } else {
          // Org bold, role italic where the original italicised roles. Drawn as
          // segments on one line when they fit; past that it falls back to
          // wrapping the whole title in bold, since splitting a font mid-wrap
          // would need a line-breaker that tracks fonts per word.
          const segs: { text: string; font: typeof regular }[] = [];
          if (entry.org) segs.push({ text: entry.org, font: bold });
          if (entry.role) {
            segs.push({ text: entry.org ? " — " : "", font: regular });
            segs.push({ text: entry.role, font: f.italicRole ? italic : bold });
          }
          if (meta) segs.push({ text: `, ${meta}`, font: metaFont });

          const totalW = segs.reduce((w, sg) => w + sg.font.widthOfTextAtSize(sg.text, body), 0);
          if (totalW <= width) {
            room(lead + 2);
            let x = MARGIN;
            for (const sg of segs) {
              if (sg.text) draw(sg.text, x, body, sg.font);
              x += sg.font.widthOfTextAtSize(sg.text, body);
            }
            y -= lead + 1;
          } else {
            for (const line of wrap([title, meta].filter(Boolean).join(", "), bold, body, width)) {
              room(lead + 2);
              draw(line, MARGIN, body, bold);
              y -= lead + 1;
            }
          }
        }
      }

      for (const bullet of entry.bullets ?? []) {
        const indent = regular.widthOfTextAtSize(`${f.bulletChar} `, body) + 4;
        for (const [i, line] of wrap(bullet, regular, body, width - indent).entries()) {
          room(lead + 1);
          if (i === 0) draw(f.bulletChar, MARGIN + 2, body, regular);
          draw(line, MARGIN + indent, body, regular);
          y -= lead;
        }
      }
      y -= 4;
    }
    y -= 4;
  }

  return Buffer.from(await pdf.save());
}
