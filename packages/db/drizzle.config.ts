import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` uses this; it diffs the schema against the
// snapshots in ./migrations and needs no database connection.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
