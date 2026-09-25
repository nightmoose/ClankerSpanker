import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * IDs of agent sessions the user deleted, so disk import doesn't bring them
 * back (RFC-051: one class instead of three copies for Grok / Claude / agy).
 * File format is unchanged: `[{ <key>: id, deletedAt }]`; a plain string
 * array (older files) is also read.
 */
export class TombstoneFile {
  private ids?: Set<string>;

  constructor(
    private readonly path: string,
    private readonly key: string,
  ) {}

  load(): Set<string> {
    if (this.ids) return this.ids;
    const set = new Set<string>();
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Array<string | Record<string, unknown>>;
        for (const entry of raw) {
          const id = typeof entry === "string" ? entry : entry?.[this.key];
          if (typeof id === "string" && id) set.add(id);
        }
      }
    } catch (err) {
      console.warn(`[sessions] failed to read ${basename(this.path)}:`, err);
    }
    this.ids = set;
    return set;
  }

  has(id: string | undefined | null): boolean {
    if (!id) return false;
    return this.load().has(id);
  }

  /** Add and persist (no-op when already present). */
  add(id: string | undefined | null): void {
    if (!id) return;
    const set = this.load();
    if (set.has(id)) return;
    set.add(id);
    const deletedAt = new Date().toISOString();
    const entries = [...set].map((v) => ({ [this.key]: v, deletedAt }));
    try {
      writeFileSync(this.path, JSON.stringify(entries, null, 2) + "\n", "utf8");
    } catch (err) {
      console.warn(`[sessions] failed to write ${basename(this.path)}:`, err);
    }
  }
}
