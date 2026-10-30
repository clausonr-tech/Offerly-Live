"use client";

import { useState } from "react";
import {
  Banknote,
  Briefcase,
  Building2,
  ChartCandlestick,
  Coins,
  ExternalLink,
  Handshake,
  Landmark,
  LineChart,
  Network,
  Presentation,
  Rocket,
  ShieldCheck,
  Smartphone,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import FirmLogo from "../discovery/FirmLogo";

// A story's picture: its photo when the pipeline found and approved one, and
// otherwise a tile that is honest about having none - the firm's logo when the
// story is about a firm, the sector's mark when it is not, the publisher's
// masthead as a last resort. Never a stand-in photo that could be mistaken for
// the story's own.
//
// The photo is the publisher's, shown from the publisher's server with no
// referrer; if it fails to load (a publisher that blocks hotlinking, a photo
// taken down) the card falls back to the tile instead of a broken image.

const SECTOR_TILES: Record<string, { icon: LucideIcon; label: string }> = {
  investment_banking: { icon: Handshake, label: "Investment Banking" },
  private_equity: { icon: Briefcase, label: "Private Equity" },
  venture_capital: { icon: Rocket, label: "Venture Capital" },
  private_credit: { icon: Banknote, label: "Private Credit" },
  real_estate: { icon: Building2, label: "Real Estate" },
  hedge_fund: { icon: LineChart, label: "Hedge Funds" },
  sales_trading: { icon: ChartCandlestick, label: "Sales & Trading" },
  asset_wealth_management: { icon: Wallet, label: "Asset & Wealth Management" },
  commercial_banking: { icon: Landmark, label: "Commercial Banking" },
  insurance: { icon: ShieldCheck, label: "Insurance" },
  fintech: { icon: Smartphone, label: "Fintech" },
  market_infrastructure: { icon: Network, label: "Market Infrastructure" },
  consulting: { icon: Presentation, label: "Consulting" },
  other_finance: { icon: Coins, label: "Finance" },
};

export type StoryImageProps = {
  imageUrl: string | null;
  source: string;
  sourceDomain: string | null;
  sector?: string | null;
  firmName?: string | null;
  firmDomain?: string | null;
  className: string;
};

export default function StoryImage(props: StoryImageProps) {
  const [failed, setFailed] = useState(false);
  if (props.imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={props.imageUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`object-cover ${props.className}`}
      />
    );
  }
  return <StoryTile {...props} />;
}

function StoryTile({ source, sourceDomain, sector, firmName, firmDomain, className }: StoryImageProps) {
  const tile = "flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-brand-50 to-brand-100";
  if (firmDomain && firmName) {
    return (
      <div className={`${tile} ${className}`}>
        <FirmLogo domain={firmDomain} name={firmName} size={56} />
        <span className="max-w-[85%] truncate text-[11px] font-medium uppercase tracking-wide text-warmgray-500">{firmName}</span>
      </div>
    );
  }
  const sectorTile = sector ? SECTOR_TILES[sector] : undefined;
  if (sectorTile) {
    const Icon = sectorTile.icon;
    return (
      <div className={`${tile} ${className}`}>
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/70 text-brand-900 shadow-sm">
          <Icon size={26} strokeWidth={1.6} aria-hidden />
        </span>
        <span className="max-w-[85%] truncate text-[11px] font-medium uppercase tracking-wide text-warmgray-500">{sectorTile.label}</span>
      </div>
    );
  }
  return (
    <div className={`${tile} ${className}`}>
      {sourceDomain ? <FirmLogo domain={sourceDomain} name={source || "?"} size={56} /> : <ExternalLink size={24} className="text-warmgray-500" />}
      {source && <span className="max-w-[85%] truncate text-[11px] font-medium uppercase tracking-wide text-warmgray-500">{source}</span>}
    </div>
  );
}
