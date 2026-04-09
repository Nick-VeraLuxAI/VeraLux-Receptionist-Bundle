/**
 * Operator-configurable branding for admin / portal / owner shells (no HTML edits).
 * See CUSTOMER_CONFIG_SURFACE.md and .env.example (BRAND_*).
 */

const DEFAULT_BRAND = "VeraLux";
const DEFAULT_LOGO =
  "https://veralux.ai/wp-content/uploads/2025/11/eralux-100-x-98-px-1-300x293.png";

function trimOrUndef(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type CustomerBrandingPayload = {
  logoUrl: string | null;
  logoAlt: string;
  admin: { documentTitle: string; consoleSubline: string };
  portal: {
    documentTitle: string;
    headerLine: string;
    footerHtml: string;
  };
  owner: { documentTitle: string };
};

export function getCustomerBrandingPayload(): CustomerBrandingPayload {
  const brandName = trimOrUndef(process.env.BRAND_NAME) ?? DEFAULT_BRAND;

  const rawLogo = process.env.BRAND_LOGO_URL;
  let logoUrl: string | null;
  if (rawLogo === undefined) {
    logoUrl = DEFAULT_LOGO;
  } else if (rawLogo.trim() === "") {
    logoUrl = null;
  } else {
    logoUrl = rawLogo.trim();
  }

  const logoAlt = trimOrUndef(process.env.BRAND_LOGO_ALT) ?? brandName;

  const adminHeadline =
    trimOrUndef(process.env.BRAND_ADMIN_HEADLINE) ?? "Neural Operations Console";
  const adminDocTitle = `${brandName} — ${adminHeadline}`;
  const adminSub =
    trimOrUndef(process.env.BRAND_ADMIN_TAGLINE) ??
    `${brandName} Receptionist · Live control plane`;

  const portalTitle =
    trimOrUndef(process.env.BRAND_PORTAL_BROWSER_TITLE) ?? "Business Portal";
  const portalDocTitle = `${portalTitle} — ${brandName}`;
  const portalHeader =
    trimOrUndef(process.env.BRAND_PORTAL_HEADER) ?? `${brandName} · Client portal`;

  const footerDisabled =
    (process.env.BRAND_PORTAL_FOOTER_DISABLED || "").toLowerCase() === "true" ||
    (process.env.BRAND_PORTAL_FOOTER_DISABLED || "").toLowerCase() === "1";
  const footerEnv = process.env.BRAND_PORTAL_FOOTER_URL;
  let footerUrlRaw: string | undefined;
  if (footerDisabled) {
    footerUrlRaw = undefined;
  } else if (footerEnv === undefined) {
    footerUrlRaw = "https://veralux.ai";
  } else if (footerEnv.trim() === "") {
    footerUrlRaw = undefined;
  } else {
    footerUrlRaw = footerEnv.trim();
  }
  const footerText =
    trimOrUndef(process.env.BRAND_PORTAL_FOOTER_LINK_TEXT) ?? `${brandName} AI`;
  let footerHtml = "";
  if (footerUrlRaw) {
    try {
      const u = new URL(footerUrlRaw);
      if (u.protocol === "http:" || u.protocol === "https:") {
        footerHtml = `Powered by <a href="${escAttr(u.href)}" target="_blank" rel="noopener noreferrer">${escHtml(footerText)}</a>`;
      }
    } catch {
      /* invalid URL — omit footer */
    }
  }

  const ownerTitle =
    trimOrUndef(process.env.BRAND_OWNER_BROWSER_TITLE) ?? "Your Receptionist";
  const ownerDocTitle = `${ownerTitle} — ${brandName}`;

  return {
    logoUrl,
    logoAlt,
    admin: {
      documentTitle: adminDocTitle,
      consoleSubline: adminSub,
    },
    portal: {
      documentTitle: portalDocTitle,
      headerLine: portalHeader,
      footerHtml,
    },
    owner: {
      documentTitle: ownerDocTitle,
    },
  };
}
