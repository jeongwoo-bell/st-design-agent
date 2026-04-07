// ============================================
// 수정안 적용 + 빌드 검증
// ============================================
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const { callHaiku } = require("./claude");

const execAsync = promisify(exec);

const BUILD_JUDGE_SYSTEM = `너는 Next.js 빌드 결과 판정기야. 빌드 출력 로그를 보고 진짜 성공인지 판단해.

## 판단 기준
- "PASS": 빌드가 완전히 성공. 경고(warning)만 있는 건 PASS.
- "FAIL: [이유]": 실질적 문제가 있음. 아래 경우에 FAIL:
  - 에러(error)가 있는데 exit code 0으로 끝난 경우
  - "Module not found", "Cannot find module" 등 import 실패
  - 페이지/컴포넌트가 정상 생성되지 않은 흔적
  - 빌드 출력이 비정상적으로 짧거나 비어있는 경우

## 무시해도 되는 것
- ESLint warning
- "middleware" deprecated 경고
- 이미지 최적화 경고
- 일반적인 warning 메시지

PASS 또는 FAIL: ... 외에 다른 말은 하지 마.`;

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
async function runBuild(repoPath) {
  console.log("[BUILDER] pnpm build 실행 중...");
  try {
    const { stdout, stderr } = await execAsync("pnpm build", {
      cwd: repoPath,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // AI 판정 — exit code 0이어도 실질적 문제가 있는지 확인
    const buildLog = `## stdout\n${stdout.slice(-2000)}\n\n## stderr\n${stderr.slice(-2000)}`;
    try {
      const judgment = await callHaiku(BUILD_JUDGE_SYSTEM, buildLog);
      const result = judgment.trim();
      if (result.startsWith("FAIL")) {
        const reason = result.replace(/^FAIL:\s*/, "");
        console.warn(`[BUILDER] AI 판정: 빌드 실패 — ${reason}`);
        return { success: false, stdout, stderr: reason };
      }
    } catch {
      // AI 판정 실패 시 exit code 기준으로 성공 처리
    }

    console.log("[BUILDER] 빌드 성공 (AI 판정 PASS)");
    return { success: true, stdout, stderr };
  } catch (err) {
    console.error("[BUILDER] 빌드 실패:", err.stderr?.slice(0, 300) || err.message);
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
