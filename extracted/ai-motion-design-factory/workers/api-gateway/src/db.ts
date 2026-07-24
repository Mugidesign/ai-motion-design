import { createDb, type Db } from "@factory/db";
import type { Env } from "./types";

/**
 * One Drizzle client per request, backed directly by DATABASE_URL (a
 * self-hosted Postgres — docker-compose.yml). Not cached at module scope
 * on purpose — see the equivalent note this used to have about
 * Hyperdrive; without Hyperdrive's connection pooling in front of it,
 * consider re-introducing a module-scoped client with an idle timeout if
 * connection-open overhead becomes a measurable bottleneck at higher
 * traffic (docs/06-oss-free-stack.md discusses this tradeoff).
 */
export function getDb(env: Env): Db {
  return createDb(env.DATABASE_URL);
}
