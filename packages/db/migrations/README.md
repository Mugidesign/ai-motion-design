# packages/db/migrations/

This folder is intentionally empty in the scaffold. It's where
`drizzle-kit`'s own generated migration files (and its `meta/_journal.json`
bookkeeping) will land the first time you run:

```bash
pnpm db:generate
```

That command reads `../src/schema.ts` and produces this folder's real
contents. From then on, this folder — not `infra/supabase/bootstrap-schema.sql`
— is the authoritative migration history; run `pnpm db:migrate` to apply
new migrations after future schema changes.

`infra/supabase/bootstrap-schema.sql` is a separate, hand-written copy of
the same schema used only to seed a fresh Postgres container via
`docker-entrypoint-initdb.d` without requiring Node/pnpm first — see its
header comment for why it's kept out of this folder.
