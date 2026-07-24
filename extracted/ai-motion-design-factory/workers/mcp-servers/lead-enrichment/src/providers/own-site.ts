/**
 * Fetches a lead's own public marketing site to extract enrichment signals.
 * Low-risk by design (docs/05 §3.1 Tier 2): this reads a company's own
 * public homepage, the same way a human sales rep would open it in a
 * browser — no login wall bypass, no rate-hammering, single page fetch.
 */
export interface SiteSignals {
  title?: string;
  description?: string;
  hasVideoTag: boolean;
  ogImage?: string;
  detectedSocialLinks: string[];
}

export async function fetchSiteSignals(url: string): Promise<SiteSignals> {
  const res = await fetch(url, { headers: { "User-Agent": "AIMotionDesignFactory-Enrichment/1.0" } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const html = await res.text();

  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  const description = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1];
  const ogImage = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i)?.[1];
  const hasVideoTag = /<video[\s>]|youtube\.com\/embed|player\.vimeo\.com/i.test(html);

  const socialPatterns = [
    /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9_.]+/gi,
    /https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9-]+/gi,
    /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[a-zA-Z0-9_]+/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|@)[a-zA-Z0-9_-]+/gi,
  ];
  const detectedSocialLinks = Array.from(
    new Set(socialPatterns.flatMap((re) => Array.from(html.matchAll(re)).map((m) => m[0])))
  );

  return { title, description, ogImage, hasVideoTag, detectedSocialLinks };
}
