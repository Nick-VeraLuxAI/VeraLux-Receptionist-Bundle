import React from "react";
import { useBranding } from "@/lib/branding";

const PUBLIC_ASSET_ROOT = process.env.PUBLIC_URL || "";
const OFFICIAL_EMBLEM = `${PUBLIC_ASSET_ROOT}/brand/veralux-emblem.png`;
const OFFICIAL_WORDMARK = `${PUBLIC_ASSET_ROOT}/brand/veralux-wordmark-name.png`;

function isVeraLuxBrand(brand) {
  return String(brand.brandName || brand.logoAlt || "VeraLux").trim().toLowerCase() === "veralux";
}

/** Official emblem from veralux.ai; white-label operators may override it through BRAND_LOGO_URL. */
export const VMark = ({ size = 28, className = "" }) => {
  const brand = useBranding();
  const configured = brand.logoUrl;
  const useOfficial =
    isVeraLuxBrand(brand) &&
    (!configured || configured === "/veralux-logo.png" || configured === "/brand/veralux-emblem.png");
  const src = useOfficial ? OFFICIAL_EMBLEM : configured;
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      width={Math.round(size * 0.92)}
      height={size}
      className={`block shrink-0 object-contain ${className}`}
      style={{ height: size, width: "auto" }}
      aria-hidden="true"
      data-testid="veralux-logo"
    />
  );
};

export const Wordmark = ({ className = "" }) => {
  const brand = useBranding();
  const label = brand.brandName || brand.logoAlt || "VeraLux";
  const configured = brand.wordmarkUrl;
  const useOfficial =
    isVeraLuxBrand(brand) &&
    (!configured || configured === "/brand/veralux-wordmark-name.png");
  const src = useOfficial ? OFFICIAL_WORDMARK : configured;
  if (src) {
    return (
      <img
        src={src}
        alt={label}
        width="109"
        height="15"
        className={`block h-[15px] w-auto object-contain ${className}`}
        data-testid="veralux-wordmark"
      />
    );
  }
  return (
    <span className={`text-[14px] font-semibold uppercase tracking-[0.22em] text-vl-text ${className}`}>
      {label}
    </span>
  );
};

export const BrandLockup = ({ variant = "portal", size = 32, descriptor }) => {
  const product = descriptor || (variant === "portal" ? "Client portal" : "Platform console");
  return (
    <div className="flex items-center gap-2.5" data-testid="brand-lockup">
      <VMark size={size} />
      <div className="flex min-w-0 flex-col gap-1">
        <Wordmark />
        <span className="font-mono text-[8px] font-medium uppercase tracking-[0.16em] text-vl-muted">{product}</span>
      </div>
    </div>
  );
};

/** Abstract voice/agent mark for the receptionist card (no photoreal avatar). */
export const VoiceMark = ({ size = 64, animate = false }) => (
  <div className="inline-flex items-center justify-center rounded-full bg-vl-gold-soft" style={{ width: size, height: size }} aria-hidden="true">
    <div className="flex items-end gap-[3px]" style={{ height: size * 0.42 }}>
      {[0.45, 0.8, 1, 0.7, 0.5].map((h, i) => (
        <span
          key={i}
          className={`block w-[4px] rounded-full bg-vl-gold-deep ${animate ? "vl-wave-bar" : ""}`}
          style={{ height: `${h * 100}%`, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  </div>
);
