import { createDb } from "@hookline/db";
import { parseArgs } from "node:util";
import { createProjectWithKey } from "./project-key";

const USAGE = 'Usage: pnpm --filter @hookline/api create-key "<project name>" [--key-name <name>]';

/**
 * Creates a project with one API key and prints the key. The key goes to
 * stdout on its own and everything else to stderr, so it can be captured:
 *   HOOKLINE_API_KEY=$(pnpm --silent --filter @hookline/api create-key Acme)
 */
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "key-name": { type: "string" } },
  });
  const [projectName] = positionals;
  if (!projectName || positionals.length > 1) {
    console.error(USAGE);
    process.exit(2);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  try {
    const created = await createProjectWithKey(db, {
      projectName,
      keyName: values["key-name"],
    });
    console.error(`Created project ${created.projectId} with API key ${created.prefix}…`);
    console.error("Copy the key now: only its hash is stored, so it cannot be shown again.");
    console.log(created.key);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
