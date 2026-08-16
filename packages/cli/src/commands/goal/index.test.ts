import { describe, expect, test, vi } from "vitest";

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  getDaemonHost: vi.fn(),
}));

import { createGoalCommand } from "./index.js";

describe("goal command", () => {
  test("exposes the durable Goal lifecycle operations", () => {
    const command = createGoalCommand();
    expect(command.commands.map((child) => child.name())).toEqual([
      "create",
      "ls",
      "show",
      "queue",
      "pause",
      "resume",
      "cancel",
      "waive",
    ]);
    expect(
      command.commands
        .find((child) => child.name() === "create")
        ?.options.map((option) => option.long),
    ).toContain("--file");
  });
});
