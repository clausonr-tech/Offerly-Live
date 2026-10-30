/**
 * Build the browser and home-screen icons from the Offerly logo's mark.
 *
 *   npx tsx scripts/build-brand-icons.ts
 *
 * Writes src/app/icon.svg, src/app/favicon.ico and src/app/apple-icon.png -
 * Next serves all three by file convention. Re-run after changing
 * src/components/brand/logo-paths.ts.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ARROW_PATH, LOGO_BLUE, MARK_VIEWBOX, RING_PATH } from "@/components/brand/logo-paths";

const svg = (ring: string, extraStyle = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}">${extraStyle}<path class="ring" fill="${ring}" fill-rule="evenodd" d="${RING_PATH}"/><path fill="${LOGO_BLUE}" fill-rule="evenodd" d="${ARROW_PATH}"/></svg>`;

async function main() {
  // icon.svg: the ring follows the browser's colour scheme, so the mark stays
  // visible on a dark tab strip.
  writeFileSync(
    path.join("src", "app", "icon.svg"),
    svg("#000000", "<style>@media (prefers-color-scheme: dark){.ring{fill:#ffffff}}</style>") + "\n",
  );

  // favicon.ico: PNG-in-ICO at 16/32/48, for browsers that ignore icon.svg.
  const base = Buffer.from(svg("#000000"));
  const sizes = [16, 32, 48];
  const pngs = await Promise.all(sizes.map((s) => sharp(base, { density: 600 }).resize(s, s).png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(s, e);
    header.writeUInt8(s, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  writeFileSync(path.join("src", "app", "favicon.ico"), Buffer.concat([header, ...pngs]));

  // apple-icon.png: iOS fills transparency with black, so the mark sits on white
  // with room around it for the home-screen corner mask.
  const mark = await sharp(base, { density: 600 }).resize(136, 136).png().toBuffer();
  await sharp({ create: { width: 180, height: 180, channels: 4, background: "#ffffff" } })
    .composite([{ input: mark, left: 22, top: 22 }])
    .png()
    .toFile(path.join("src", "app", "apple-icon.png"));
  console.log("icons written");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
