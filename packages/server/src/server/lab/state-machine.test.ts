import { describe, expect, test } from "vitest";
import { canTransitionLabGoal } from "./state-machine.js";

describe("lab goal state machine", () => {
  test("only allows lifecycle edges declared by the product state machine", () => {
    expect(canTransitionLabGoal("draft", "queued")).toBe(true);
    expect(canTransitionLabGoal("reviewing", "repairing")).toBe(true);
    expect(canTransitionLabGoal("paused", "implementing")).toBe(true);
    expect(canTransitionLabGoal("completed", "implementing")).toBe(false);
    expect(canTransitionLabGoal("draft", "completed")).toBe(false);
  });
});
