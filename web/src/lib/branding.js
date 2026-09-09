import React from "react";
import { useLocation } from "react-router-dom";
import { publicApi } from "@/lib/api";

const DEFAULTS = {
  brandName: "VeraLux",
  logoUrl: "/brand/veralux-emblem.png",
  wordmarkUrl: "/brand/veralux-wordmark-name.png",
  logoAlt: "VeraLux",
  admin: { documentTitle: "VeraLux Platform", consoleSubline: "Platform console" },
  portal: { documentTitle: "VeraLux Portal", headerLine: "Client portal", footerHtml: "" },
  owner: { documentTitle: "VeraLux" },
};

const BrandingCtx = React.createContext(DEFAULTS);

export function useBranding() {
  return React.useContext(BrandingCtx);
}

export function BrandingProvider({ children }) {
  const location = useLocation();
  const [brand, setBrand] = React.useState(null);
  React.useEffect(() => {
    publicApi
      .get("/api/branding")
      .then((p) => {
        if (p && typeof p === "object") setBrand(p);
      })
      .catch(() => {
        /* keep defaults */
      });
  }, []);
  const value = React.useMemo(
    () => ({
      ...DEFAULTS,
      ...(brand || {}),
      admin: { ...DEFAULTS.admin, ...((brand && brand.admin) || {}) },
      portal: { ...DEFAULTS.portal, ...((brand && brand.portal) || {}) },
      owner: { ...DEFAULTS.owner, ...((brand && brand.owner) || {}) },
    }),
    [brand],
  );
  React.useEffect(() => {
    const path = location.pathname;
    if (path.startsWith("/portal")) document.title = value.portal.documentTitle || "VeraLux Portal";
    else if (path.startsWith("/admin")) document.title = value.admin.documentTitle || "VeraLux Platform";
    else document.title = value.admin.documentTitle || "VeraLux";
  }, [value, location.pathname]);
  return <BrandingCtx.Provider value={value}>{children}</BrandingCtx.Provider>;
}
