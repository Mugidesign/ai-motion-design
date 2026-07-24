/**
 * Calls an agent Durable Object through the AGENTS_WORKER service binding.
 * Service bindings route directly worker-to-worker inside Cloudflare's
 * network — the hostname in the URL below is never actually resolved over
 * DNS, only the path matters, but a well-formed URL is still required by
 * the Fetcher interface.
 */
export interface AgentCallEnv {
  AGENTS_WORKER: Fetcher;
}

export async function callAgent<T = unknown>(
  env: AgentCallEnv,
  agentSlug: string,
  tenantId: string,
  payload: unknown
): Promise<T> {
  const res = await env.AGENTS_WORKER.fetch(`https://agents-worker.internal/agents/${agentSlug}/${tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`agent "${agentSlug}" call failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
