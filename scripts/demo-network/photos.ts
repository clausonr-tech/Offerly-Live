// Post photos for the demo network, drawn here rather than downloaded.
//
// Each scene is an SVG rendered to a JPEG by sharp (already a dependency via
// Next), so the demo database carries real image bytes through the app's own
// storage path - the same /api/post-image route a student's upload uses -
// without fetching anything or raising a licensing question. They are
// illustrations, not camera photos, and are only ever seeded into the local
// demo database (see seed-demo-network.ts).
import sharp from "sharp";

export type Rand = () => number;

const W = 1200;
const H = 800;

function pick<T>(r: Rand, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
const SERIF = "Georgia, Times New Roman, serif";

/** A city at dusk or night: layered towers, lit windows, a gradient sky. */
function skyline(r: Rand): string {
  const skies = [
    ["#1b2a4a", "#6a4c93", "#f4a261"],
    ["#0b132b", "#1c2541", "#3a506b"],
    ["#2d1e4a", "#c0587e", "#ffb26b"],
    ["#10263f", "#2e5c8a", "#9fc5e8"],
  ];
  const [a, b, c] = pick(r, skies);
  let towers = "";
  for (const layer of [0, 1]) {
    let x = -20;
    while (x < W) {
      const w = 50 + r() * 90;
      const h = (layer ? 260 : 360) + r() * (layer ? 260 : 300);
      const fill = layer ? "#0d1321" : "#1d2640";
      towers += `<rect x="${x.toFixed(0)}" y="${(H - h).toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="${fill}"/>`;
      if (layer) {
        for (let wy = H - h + 18; wy < H - 20; wy += 22) {
          for (let wx = x + 8; wx < x + w - 10; wx += 16) {
            if (r() < 0.32) towers += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="7" height="10" fill="#ffd98a" opacity="${(0.55 + r() * 0.45).toFixed(2)}"/>`;
          }
        }
        if (r() < 0.25) towers += `<rect x="${(x + w / 2 - 2).toFixed(0)}" y="${(H - h - 40).toFixed(0)}" width="4" height="40" fill="#0d1321"/>`;
      }
      x += w + (layer ? 4 : -10);
    }
  }
  return `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="0.6" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#s)"/>
  <circle cx="${200 + r() * 800}" cy="${120 + r() * 120}" r="${30 + r() * 20}" fill="#fff4d6" opacity="0.8"/>
  ${towers}`;
}

/** An offer letter on a desk, a pen beside it. */
function offerLetter(r: Rand, firm: string, name: string): string {
  const desk = pick(r, ["#6b4f3a", "#4a3728", "#8a6a4f"]);
  const rot = (r() * 6 - 3).toFixed(1);
  let lines = "";
  for (let i = 0; i < 9; i++) {
    const w = 380 + r() * 180;
    lines += `<rect x="330" y="${400 + i * 26}" width="${w.toFixed(0)}" height="8" rx="4" fill="#c9ced6"/>`;
  }
  return `<rect width="${W}" height="${H}" fill="${desk}"/>
  <rect width="${W}" height="${H}" fill="url(#grain)" opacity="0.25"/>
  <defs><pattern id="grain" width="40" height="8" patternUnits="userSpaceOnUse"><rect width="40" height="2" fill="#000" opacity="0.2"/></pattern></defs>
  <g transform="rotate(${rot} 600 400)">
    <rect x="290" y="70" width="620" height="700" fill="#fdfdfb" stroke="#e3e3e3"/>
    <text x="330" y="150" font-family="${SERIF}" font-size="34" fill="#1d2640">${esc(firm)}</text>
    <rect x="330" y="170" width="540" height="2" fill="#1d2640"/>
    <text x="330" y="240" font-family="${SERIF}" font-size="22" fill="#333">Dear ${esc(name)},</text>
    <text x="330" y="300" font-family="${SERIF}" font-size="22" fill="#333">We are delighted to extend you an offer</text>
    <text x="330" y="332" font-family="${SERIF}" font-size="22" fill="#333">to join our Summer Analyst Program.</text>
    ${lines}
  </g>
  <rect x="930" y="220" width="18" height="360" rx="9" fill="#1b1b1b" transform="rotate(18 939 400)"/>
  <rect x="930" y="220" width="18" height="40" rx="9" fill="#c9a227" transform="rotate(18 939 400)"/>`;
}

/** A stock chart on a dark terminal. */
function chart(r: Rand, ticker: string): string {
  let y = 480;
  const pts: string[] = [];
  for (let x = 80; x <= 1120; x += 20) {
    y += (r() - 0.46) * 38;
    y = Math.max(160, Math.min(680, y));
    pts.push(`${x},${y.toFixed(0)}`);
  }
  const up = r() < 0.7;
  const color = up ? "#3ddc97" : "#ff6b6b";
  let grid = "";
  for (let gy = 160; gy <= 680; gy += 104) grid += `<line x1="80" y1="${gy}" x2="1120" y2="${gy}" stroke="#2a3246" stroke-width="1"/>`;
  return `<rect width="${W}" height="${H}" fill="#0f1420"/>
  ${grid}
  <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round"/>
  <text x="80" y="100" font-family="${FONT}" font-size="44" font-weight="700" fill="#e8ecf5">${esc(ticker)}</text>
  <text x="80" y="140" font-family="${FONT}" font-size="24" fill="${color}">${up ? "+" : "-"}${(r() * 4 + 0.3).toFixed(2)}% today</text>
  <text x="1120" y="100" text-anchor="end" font-family="${FONT}" font-size="22" fill="#7b86a3">1D  5D  1M  6M  1Y</text>`;
}

/** A laptop with a spreadsheet open, and a coffee. */
function spreadsheetDesk(r: Rand): string {
  const wall = pick(r, ["#dfe6ee", "#e9e3d8", "#d7dde8"]);
  let cells = "";
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 7; col++) {
      const x = 330 + col * 78;
      const yy = 210 + row * 26;
      cells += `<rect x="${x}" y="${yy}" width="78" height="26" fill="${row === 0 ? "#dbe8d4" : "#ffffff"}" stroke="#c7cdd6" stroke-width="1"/>`;
      if (col > 0 && row > 0 && r() < 0.8) cells += `<rect x="${x + 12}" y="${yy + 10}" width="${(30 + r() * 30).toFixed(0)}" height="6" rx="3" fill="${r() < 0.15 ? "#2b6cb0" : "#7a8290"}"/>`;
    }
  }
  return `<rect width="${W}" height="${H}" fill="${wall}"/>
  <rect y="560" width="${W}" height="240" fill="#a07852"/>
  <rect x="300" y="170" width="600" height="380" rx="16" fill="#23262d"/>
  <rect x="318" y="188" width="564" height="344" fill="#ffffff"/>
  ${cells}
  <path d="M250 560 H950 L990 600 H210 Z" fill="#3a3f48"/>
  <rect x="990" y="470" width="90" height="110" rx="10" fill="#f4f1ea"/>
  <path d="M1080 495 q40 25 0 55" fill="none" stroke="#f4f1ea" stroke-width="12"/>
  <ellipse cx="1035" cy="475" rx="45" ry="10" fill="#5b3a1e"/>`;
}

/** A conference name badge on a lanyard. */
function nameBadge(r: Rand, firm: string, name: string): string {
  const band = pick(r, ["#1d3557", "#6a4c93", "#264653", "#9d0208"]);
  return `<rect width="${W}" height="${H}" fill="#e7e2d8"/>
  <path d="M520 0 L600 250 L680 0" fill="none" stroke="${band}" stroke-width="26"/>
  <rect x="380" y="240" width="440" height="500" rx="18" fill="#ffffff" stroke="#cfcfcf"/>
  <rect x="380" y="240" width="440" height="110" rx="18" fill="${band}"/>
  <rect x="380" y="320" width="440" height="30" fill="${band}"/>
  <text x="600" y="310" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="700" fill="#ffffff">${esc(firm)}</text>
  <text x="600" y="470" text-anchor="middle" font-family="${FONT}" font-size="46" font-weight="700" fill="#1b1b1b">${esc(name.split(" ")[0])}</text>
  <text x="600" y="520" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#555">${esc(name.split(" ").slice(1).join(" "))}</text>
  <rect x="440" y="600" width="320" height="50" rx="25" fill="#f1f1f1"/>
  <text x="600" y="634" text-anchor="middle" font-family="${FONT}" font-size="24" fill="#333">STUDENT GUEST</text>`;
}

/** Index cards with a technical question each. */
function flashcards(r: Rand): string {
  const qs = [
    "Walk me through a DCF",
    "What is WACC?",
    "3 statements: +$10 depreciation",
    "EV vs. equity value",
    "Why would a company issue debt?",
    "Accretion / dilution basics",
    "LBO: what drives returns?",
    "How do you value a bank?",
  ];
  let cards = "";
  for (let i = 0; i < 4; i++) {
    const x = 140 + i * 230 + r() * 40;
    const y = 180 + r() * 260;
    const rot = (r() * 16 - 8).toFixed(1);
    cards += `<g transform="rotate(${rot} ${x + 150} ${y + 100})">
      <rect x="${x}" y="${y}" width="300" height="200" fill="#fffef6" stroke="#ddd"/>
      <line x1="${x}" y1="${y + 50}" x2="${x + 300}" y2="${y + 50}" stroke="#e76f51" stroke-width="2"/>
      <text x="${x + 18}" y="${y + 36}" font-family="${FONT}" font-size="16" fill="#1d3557">${esc(pick(r, qs))}</text>
      <line x1="${x + 18}" y1="${y + 90}" x2="${x + 270}" y2="${y + 90}" stroke="#bcd" /><line x1="${x + 18}" y1="${y + 125}" x2="${x + 240}" y2="${y + 125}" stroke="#bcd"/><line x1="${x + 18}" y1="${y + 160}" x2="${x + 260}" y2="${y + 160}" stroke="#bcd"/>
    </g>`;
  }
  return `<rect width="${W}" height="${H}" fill="${pick(r, ["#3d405b", "#2b2d42", "#354f52"])}"/>${cards}`;
}

/** A campus clock tower at sunset. */
function campus(r: Rand): string {
  const [a, b] = pick(r, [["#ff9a8b", "#ff6a88"], ["#fbc2eb", "#a6c1ee"], ["#f6d365", "#fda085"], ["#89f7fe", "#66a6ff"]]);
  let trees = "";
  for (let x = 0; x < W; x += 60 + r() * 40) trees += `<circle cx="${x.toFixed(0)}" cy="${(620 + r() * 30).toFixed(0)}" r="${(50 + r() * 30).toFixed(0)}" fill="#1f3d2b"/>`;
  return `<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#c)"/>
  <rect x="200" y="420" width="800" height="240" fill="#6b3e26"/>
  <rect x="540" y="180" width="120" height="480" fill="#7a4a2e"/>
  <path d="M530 180 L600 90 L670 180 Z" fill="#4a2a18"/>
  <circle cx="600" cy="250" r="38" fill="#f5efe0"/>
  <line x1="600" y1="250" x2="600" y2="225" stroke="#333" stroke-width="4"/><line x1="600" y1="250" x2="618" y2="258" stroke="#333" stroke-width="4"/>
  ${Array.from({ length: 8 }, (_, i) => `<rect x="${240 + i * 95}" y="470" width="40" height="70" fill="#f2d49b" opacity="0.8"/>`).join("")}
  ${trees}
  <rect y="680" width="${W}" height="120" fill="#2f5d3a"/>`;
}

/** Two coffees and a notebook: a coffee chat. */
function coffeeChat(r: Rand): string {
  const table = pick(r, ["#c8a27a", "#b08968", "#d9c2a3"]);
  const cup = (cx: number, cy: number) => `<ellipse cx="${cx}" cy="${cy + 8}" rx="120" ry="40" fill="#000" opacity="0.12"/>
    <ellipse cx="${cx}" cy="${cy}" rx="110" ry="36" fill="#ffffff"/><ellipse cx="${cx}" cy="${cy - 4}" rx="80" ry="24" fill="#6f4e37"/>
    <ellipse cx="${cx - 10}" cy="${cy - 8}" rx="26" ry="8" fill="#d8b894"/>`;
  return `<rect width="${W}" height="${H}" fill="${table}"/>
  ${cup(330, 330)}${cup(870, 300)}
  <rect x="420" y="470" width="360" height="260" rx="8" fill="#1d3557" transform="rotate(-6 600 600)"/>
  <rect x="440" y="485" width="320" height="230" fill="#fbfbf7" transform="rotate(-6 600 600)"/>
  ${Array.from({ length: 6 }, (_, i) => `<rect x="465" y="${515 + i * 32}" width="${(180 + r() * 90).toFixed(0)}" height="6" rx="3" fill="#8a94a6" transform="rotate(-6 600 600)"/>`).join("")}
  <rect x="800" y="560" width="14" height="200" rx="7" fill="#222" transform="rotate(-30 807 660)"/>`;
}

export type SceneKind =
  | "skyline"
  | "offer"
  | "chart"
  | "spreadsheet"
  | "badge"
  | "flashcards"
  | "campus"
  | "coffee";

export async function renderScene(
  kind: SceneKind,
  r: Rand,
  ctx: { firm: string; name: string; ticker: string },
): Promise<Buffer> {
  const body =
    kind === "skyline" ? skyline(r)
    : kind === "offer" ? offerLetter(r, ctx.firm, ctx.name)
    : kind === "chart" ? chart(r, ctx.ticker)
    : kind === "spreadsheet" ? spreadsheetDesk(r)
    : kind === "badge" ? nameBadge(r, ctx.firm, ctx.name)
    : kind === "flashcards" ? flashcards(r)
    : kind === "campus" ? campus(r)
    : coffeeChat(r);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
}
