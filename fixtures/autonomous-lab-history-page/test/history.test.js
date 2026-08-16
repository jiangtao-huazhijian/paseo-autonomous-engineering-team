import test from "node:test";
import assert from "node:assert/strict";
import { filterTasks } from "../src/history.js";

test("filters the task history by selected status", () => {
  const tasks = [
    { id: "1", status: "completed" },
    { id: "2", status: "failed" },
    { id: "3", status: "running" },
  ];
  assert.deepEqual(filterTasks(tasks, "failed"), [{ id: "2", status: "failed" }]);
});
