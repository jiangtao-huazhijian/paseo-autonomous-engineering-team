import { filterTasks } from "../src/history.js";

if (typeof filterTasks !== "function") throw new Error("history module is not buildable");
console.log("history-page build passed");
