/**
 * Embedding provider — default is Workers AI's bge-base-en-v1.5 (768 dims,
 * open-weight, free tier: 10K Workers AI inferences/day as of this
 * scaffold's authoring). OpenAI's text-embedding-3-small (1536 dims) is
 * available as an opt-in alternative for higher-quality retrieval, but
 * needs `packages/db/src/schema.ts`'s `knowledge_chunks.embedding` column
 * (and the matching migration) changed back to vector(1536) — the two are
 * not interchangeable within the same column. See docs/06-oss-free-stack.md.
 */
export interface EmbeddingEnv {
  AI: Ai;
  OPENAI_API_KEY?: string;
  EMBEDDING_PROVIDER?: "workers-ai" | "openai";
}

export async function embed(env: EmbeddingEnv, text: string): Promise<number[]> {
  const provider = env.EMBEDDING_PROVIDER ?? "workers-ai";

  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error('EMBEDDING_PROVIDER is "openai" but OPENAI_API_KEY is not set');
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    });
    if (!res.ok) throw new Error(`OpenAI embedding failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0]!.embedding;
  }

  // Default: Workers AI, open-weight, free tier.
  const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [text] });
  return (result as { data: number[][] }).data[0]!;
}
