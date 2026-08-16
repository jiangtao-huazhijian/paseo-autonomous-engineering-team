import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoredLabGoalSchema, type StoredLabGoal } from "@getpaseo/protocol/lab/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

export class LabGoalStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<StoredLabGoal[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const goals = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) =>
          StoredLabGoalSchema.parse(JSON.parse(await readFile(join(this.dir, entry.name), "utf8"))),
        ),
    );
    return goals.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string): Promise<StoredLabGoal | null> {
    await this.ensureDir();
    try {
      return StoredLabGoalSchema.parse(JSON.parse(await readFile(this.filePath(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(goal: Omit<StoredLabGoal, "id">): Promise<StoredLabGoal> {
    await this.ensureDir();
    const created = StoredLabGoalSchema.parse({
      ...goal,
      id: `goal_${randomBytes(8).toString("hex")}`,
    });
    await writeJsonFileAtomic(this.filePath(created.id), created);
    return created;
  }

  async update(
    id: string,
    updater: (goal: StoredLabGoal) => StoredLabGoal | Promise<StoredLabGoal>,
  ): Promise<StoredLabGoal | null> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await this.get(id);
        if (!current) {
          return null;
        }
        const updated = StoredLabGoalSchema.parse(await updater(current));
        if (updated.id !== id) {
          throw new Error(`Goal update cannot change id: ${id}`);
        }
        await writeJsonFileAtomic(this.filePath(id), updated);
        return updated;
      });
    this.mutations.set(id, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(id) === next) {
        this.mutations.delete(id);
      }
    }
  }

  async delete(id: string): Promise<void> {
    await this.ensureDir();
    await rm(this.filePath(id), { force: true });
  }
}
