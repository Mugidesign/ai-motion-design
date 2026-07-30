/**
 * @factory/health-kit — shared /health endpoint logic for every Worker in
 * this repo. Deliberately small and dependency-light (imports `postgres`
 * directly rather than going through @factory/db's Drizzle wrapper, so a
 * health check never depends on the full schema being resolvable).
 *
 * A health check that unconditionally returns `{ ok: true }` only proves
 * the Worker's own JS executed — it says nothing about whether the
 * Worker can actually do its job (reach Postgres, reach another Worker,
 * etc.), which is exactly the failure mode a *post-deploy* health check
 * exists to catch. Every check here does real work, with a timeout so a
 * hung dependency can't hang the health check itself.
 */
import postgres from "postgres";

export type CheckStatus = "ok" | "error" | "skipped";

export interface CheckResult {
  status: CheckStatus;
  latencyMs?: number;
  error?: string;
}

export interface HealthReport {
  ok: boolean;
  service: string;
  timestamp: string;
  checks: Record<string, CheckResult>;
}

const DEFAULT_TIMEOUT_MS = 3000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Pings Postgres with `select 1` — cheap, no table/schema dependency, so
 * this stays valid even if a migration is mid-flight. Opens a fresh
 * one-off connection and closes it immediately after: a health check
 * runs rarely enough that reusing the app's normal pooled connection
 * isn't worth the added coupling.
 */
export async function checkDatabase(databaseUrl: string | undefined, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CheckResult> {
  if (!databaseUrl) {
    return { status: "skipped", error: "DATABASE_URL not configured" };
  }
  const start = Date.now();
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: Math.ceil(timeoutMs / 1000), fetch_types: false, prepare: false });
  try {
    await withTimeout(sql`select 1`, timeoutMs, "database check");
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "error", latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Don't await -- closing shouldn't add latency to the health check's
    // own response, and a health-check connection has nothing pending
    // that needs a clean drain.
    void sql.end({ timeout: 1 });
  }
}

/**
 * Pings another Worker's own /health endpoint via a service binding (not
 * a raw URL fetch) -- e.g. api-gateway checking that agents-worker is up.
 * Reuses whatever health status the upstream Worker already computed
 * rather than re-deriving it, so a chain of N workers doesn't turn into
 * N times the DB load on every health check.
 */
export async function checkUpstreamWorker(fetcher: Fetcher, label: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await withTimeout(fetcher.fetch(`https://${label}.internal/health`), timeoutMs, `${label} health check`);
    if (!res.ok) {
      return { status: "error", latencyMs: Date.now() - start, error: `HTTP ${res.status}` };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "error", latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs every check in parallel (independent failures shouldn't wait on
 * each other) and assembles the standard response shape + HTTP status
 * this repo's Workers all use: 200 if every check passed or was
 * skipped, 503 if anything errored. A CI post-deploy smoke test
 * (.github/workflows/deploy.yml, scripts/health-check.sh) treats
 * anything but 200 as a failed deploy.
 */
export async function buildHealthReport(
  service: string,
  checks: Record<string, () => Promise<CheckResult>>
): Promise<{ body: HealthReport; httpStatus: number }> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, run]) => [name, await run()] as const)
  );
  const resolvedChecks = Object.fromEntries(entries);
  const ok = Object.values(resolvedChecks).every((c) => c.status !== "error");

  return {
    body: { ok, service, timestamp: new Date().toISOString(), checks: resolvedChecks },
    httpStatus: ok ? 200 : 503,
  };
}
