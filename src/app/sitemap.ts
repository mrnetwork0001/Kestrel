import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const now = new Date();
  return ["", "/app", "/how-it-works", "/agents", "/token", "/rescue"].map((p) => ({ url: `${base}${p}`, lastModified: now, changeFrequency: p === "" || p === "/app" ? "hourly" : "weekly", priority: p === "" ? 1 : 0.7 }));
}
