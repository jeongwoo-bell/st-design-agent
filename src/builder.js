// ============================================
// 수정안 적용 + 빌드 검증
// ============================================
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

/**
 * 수정안을 실제 파일에 적용
 * @param {Array} changes - [{ type: "edit"|"create", filePath, ... }]
 * @param {string} repoPath - 레포 루트 경로
 * @returns {{ applied: Array, failed: Array }}
 *   applied: 성공한 change 객체 배열
 *   failed: { change, reason } 배열
 */
async function applyChanges(changes, repoPath) {
  const applied = [];
  const failed = [];

  for (const change of changes) {
    const absPath = path.join(repoPath, change.filePath);

    try {
      if (change.type === "create") {
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        await fs.promises.writeFile(absPath, change.content, "utf-8");
        console.log(`[BUILDER] 생성: ${change.filePath}`);
        applied.push(change);
      } else if (change.type === "edit") {
        const current = await fs.promises.readFile(absPath, "utf-8");

        if (!current.includes(change.oldString)) {
          const preview = change.oldString.slice(0, 80).replace(/\n/g, "\\n");
          const reason = `old_string을 찾을 수 없음: "${preview}..."`;
          console.warn(`[BUILDER] EDIT 실패 — ${change.filePath}: ${reason}`);
          failed.push({ change, reason });
          continue;
        }

        const count = current.split(change.oldString).length - 1;
        if (count > 1) {
          const reason = `old_string이 ${count}번 존재 — 더 구체적인 old_string 필요`;
          console.warn(`[BUILDER] EDIT 실패 — ${change.filePath}: ${reason}`);
          failed.push({ change, reason });
          continue;
        }

        const updated = current.replace(change.oldString, change.newString);
        await fs.promises.writeFile(absPath, updated, "utf-8");
        console.log(`[BUILDER] 수정: ${change.filePath}`);
        applied.push(change);
      }
    } catch (err) {
      failed.push({ change, reason: err.message });
    }
  }

  return { applied, failed };
}

/**
 * pnpm build 실행
 */
async function runBuild(repoPath, emit) {
  const _emit = typeof emit === "function" ? emit : () => {};
  console.log("[BUILDER] pnpm build 실행 중...");
  _emit("log", { step: "build", message: "pnpm build 실행 중..." });
  try {
    const { stdout, stderr } = await execAsync("pnpm build", {
      cwd: repoPath,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    console.log("[BUILDER] 빌드 성공");
    _emit("log", { step: "build", message: "빌드 성공" });
    return { success: true, stdout, stderr };
  } catch (err) {
    console.error("[BUILDER] 빌드 실패:", err.stderr?.slice(0, 300) || err.message);
    _emit("log", { step: "build", message: "빌드 실패" });
    return {
      success: false,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message,
    };
  }
}

/**
 * 변경사항 되돌리기
 */
async function revertChanges(repoPath) {
  console.log("[BUILDER] 변경사항 되돌리는 중...");
  await execAsync("git checkout .", { cwd: repoPath });
  await execAsync("git clean -fd", { cwd: repoPath });
  console.log("[BUILDER] 되돌리기 완료");
}

module.exports = { applyChanges, runBuild, revertChanges };
