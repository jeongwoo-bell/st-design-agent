const path = require("path");
const fs = require("fs");

const THREAD_MAP_FILE = path.join(
  process.env.THREAD_MAP_PATH || "/tmp",
  "design-bot-thread-map.json",
);

function loadThreadMap() {
  try {
    const data = JSON.parse(fs.readFileSync(THREAD_MAP_FILE, "utf-8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveThreadMap(map) {
  try {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(THREAD_MAP_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[MAP] 저장 실패:", err.message);
  }
}

const threadBranchMap = loadThreadMap();

module.exports = { threadBranchMap, saveThreadMap };
