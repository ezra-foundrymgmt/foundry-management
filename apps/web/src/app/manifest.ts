import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CreatorOS — Foundry Management",
    short_name: "CreatorOS",
    description: "Foundry Management's secure creator operations system.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f3f0e9",
    theme_color: "#1c1d1b",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
