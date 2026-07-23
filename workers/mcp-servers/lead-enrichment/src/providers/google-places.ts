import type { CompanyCandidate } from "@factory/shared-types";

/**
 * Google Places API adapter — Tier 1 compliant source (docs/05 §3.1).
 * Uses the official Places API (New) Text Search endpoint. Verify field
 * names against https://developers.google.com/maps/documentation/places/web-service
 * before production use; this environment has no network access to test
 * a live key against.
 */
export async function searchGoogleMaps(
  apiKey: string,
  query: { industry?: string; region?: string; keyword?: string },
  maxResults: number
): Promise<CompanyCandidate[]> {
  const textQuery = [query.keyword, query.industry, query.region].filter(Boolean).join(" ") || "local business";

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.displayName,places.websiteUri,places.id,places.internationalPhoneNumber",
    },
    body: JSON.stringify({ textQuery, maxResultCount: Math.min(maxResults, 20) }),
  });

  if (!res.ok) throw new Error(`Google Places request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    places?: { displayName?: { text: string }; websiteUri?: string; id: string }[];
  };

  return (data.places ?? []).map((p) => ({
    companyName: p.displayName?.text ?? "unknown",
    websiteUrl: p.websiteUri,
    source: "google_maps" as const,
    sourceProvider: "google_places_api",
  }));
}
