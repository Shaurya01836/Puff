import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Served at `/sitemap.xml`. The site is one page, so the map is one entry plus
 * the two plain-text files the footer links to.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/llms.txt`,
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];
}
