import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Casei",
    short_name: "Casei",
    description: "Organize a vida que vocês compartilham.",
    start_url: "/",
    display: "standalone",
    background_color: "#fbfaf7",
    theme_color: "#183d34",
    icons: [
      {
        src: "/icon-1024.png",
        sizes: "1254x1254",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
