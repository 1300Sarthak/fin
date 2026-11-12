import type { MetadataRoute } from "next";

/**
 * Installed to the iPhone home screen, so `display: standalone` matters more
 * than the rest: it drops Safari's chrome and makes the daily-spend number the
 * whole screen. `start_url` is `/` — the responsive overview; the old `/m`
 * phone home no longer exists.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Finance",
    short_name: "Finance",
    description: "Daily spending allowance, accounts, and burn.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
