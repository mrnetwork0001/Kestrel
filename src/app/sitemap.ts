import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const now = new Date();
  return ["", "/app", "/how-it-works", "/agents", "/token", "/rescue"].map((p) => ({ url: `${base}${p}`, lastModified: now, changeFrequency: p === "" || p === "/app" ? "hourly" : "weekly", priority: p === "" ? 1 : 0.7 }));
}
