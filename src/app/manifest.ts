import type { MetadataRoute } from "next";

/**
 * Installed to the iPhone home screen, so `display: standalone` matters more
 * than the rest: it drops Safari's chrome and makes the daily-spend number the
 * whole screen. `start_url` points at the phone home rather than `/`, which is
 * the desktop dashboard.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Finance",
    short_name: "Finance",
    description: "Daily spending allowance, accounts, and burn.",
    start_url: "/m",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
