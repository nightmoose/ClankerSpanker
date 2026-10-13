import type { HostConfigFile } from "./types.js";

/**
 * RFC-058 — Per-project secret slots. The slot *name* is public (it
 * appears in `ProjectDatabase.connectionRef` and in tool call payloads);
 * the value is not. All writes go through here so there's one place to
 * audit — the handler for `secret_request` and the "Set connection
 * string" button on the project edit sheet both land in `set`.
 *
 * The map is kept out of every HTTP response by convention: no route
 * returns `config.projectSecrets`, and the project JSON surfaces
 * `database.connectionRef` only (the pointer, not the value). Future
 * work (Keychain / libsecret) swaps this module out without changing
 * callers.
 */

export function get(
  config: HostConfigFile,
  projectId: string,
  slot: string,
): string | undefined {
  return config.projectSecrets?.[projectId]?.[slot];
}

export function set(
  config: HostConfigFile,
  projectId: string,
  slot: string,
  value: string,
): void {
  if (!config.projectSecrets) config.projectSecrets = {};
  const bucket = config.projectSecrets[projectId] ?? {};
  bucket[slot] = value;
  config.projectSecrets[projectId] = bucket;
}

export function remove(config: HostConfigFile, projectId: string, slot: string): boolean {
  const bucket = config.projectSecrets?.[projectId];
  if (!bucket || !(slot in bucket)) return false;
  delete bucket[slot];
  if (Object.keys(bucket).length === 0) {
    delete config.projectSecrets![projectId];
  }
  return true;
}

/** Drop every secret bound to a project — used when a project is deleted. */
export function removeAllForProject(config: HostConfigFile, projectId: string): void {
  if (config.projectSecrets && projectId in config.projectSecrets) {
    delete config.projectSecrets[projectId];
  }
}

/** Slot name used for a project's primary database connection string. */
export const DATABASE_CONNECTION_SLOT = "project.database_connection";
