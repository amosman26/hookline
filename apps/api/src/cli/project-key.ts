import { apiKeys, projects, type Database } from "@hookline/db";
import { generateApiKey } from "../auth/api-key";

export const MAX_NAME_LENGTH = 100;

export interface CreatedProjectKey {
  projectId: string;
  apiKeyId: string;
  /** The full key. It is not stored, so this is the only chance to see it. */
  key: string;
  prefix: string;
}

function checkName(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`${label} must be 1-${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * Creates a project and its first API key in one transaction, so a failure
 * never leaves a project nobody can call the API as. Until the dashboard
 * exists this is the only way to get a key.
 */
export async function createProjectWithKey(
  db: Database,
  input: { projectName: string; keyName?: string },
): Promise<CreatedProjectKey> {
  const projectName = checkName("project name", input.projectName);
  const keyName = checkName("key name", input.keyName ?? "default");
  const generated = generateApiKey();

  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ name: projectName })
      .returning({ id: projects.id });
    if (!project) throw new Error("insert returned no project");
    const [apiKey] = await tx
      .insert(apiKeys)
      .values({
        projectId: project.id,
        name: keyName,
        prefix: generated.prefix,
        keyHash: generated.hash,
      })
      .returning({ id: apiKeys.id });
    if (!apiKey) throw new Error("insert returned no API key");
    return {
      projectId: project.id,
      apiKeyId: apiKey.id,
      key: generated.key,
      prefix: generated.prefix,
    };
  });
}
