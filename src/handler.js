// ============================================
// v5 오케스트레이터 — 봇이 전체 흐름을 직접 제어
// ============================================
const path = require("path");
const { CONFIG } = require("./config");
const { MESSAGES } = require("./messages");
const { run, ensureRepo, switchToBranch } = require("./git");
const { TALK_SYSTEM_PROMPT, ASK_SYSTEM_PROMPT } = require("../wizkey-prompt");
const { threadBranchMap, saveThreadMap } = require("./thread-map");
const { enqueueRequest, getQueueLength } = require("./queue");
const {
  truncateForSlack,
  createBranchName,
  containsFigmaLink,
} = require("./parser");
const { waitForVercelDeployment } = require("./vercel");
const {
  classifyMessage,
  generateTmi,
  summarizeChanges,
  verifyChanges,
} = require("./classifier");
const { collectFileTree, identifyRelevantFiles, readFiles } = require("./file-analyzer");
const { fetchFigmaData } = require("./figma");
const { generateCodeChanges, fixBuildError } = require("./code-generator");
const { applyChanges, runBuild, revertChanges } = require("./builder");
const { WebClient } = require("@slack/web-api");
const slackClient = new WebClient(CONFIG.slack.botToken);

async function addReaction(channel, timestamp, name) {
  try {
    await slackClient.reactions.add({ channel, timestamp, name });
  } catch (err) {
    console.warn(`[REACTION] ${name} 추가 실패:`, err.message);
  }
}

async function getUserName(userId) {
  try {
    const result = await slackClient.users.info({ user: userId });
    const profile = result.user.profile || {};
    const name = profile.display_name || profile.real_name || result.user.real_name || result.user.name || null;
    console.log(`[USER] 이름 조회 성공: ${userId} → ${name}`);
    return name;
  } catch (err) {
    console.warn(`[USER] 이름 가져오기 실패 (${userId}):`, err.message);
    return null;
  }
}

async function processRequest(message, say, threadTs, channel, messageTs, userId) {
  // 👀 리액션으로 확인 표시 + 유저 이름 가져오기 (병렬)
  const [, userName] = await Promise.all([
    channel && messageTs ? addReaction(channel, messageTs, "eyes") : Promise.resolve(),
    userId ? getUserName(userId) : Promise.resolve(null),
  ]);

  // Haiku로 분류
  console.log("[CLASSIFIER] 메시지 분류 중...");
  const category = await classifyMessage(message);
  console.log(`[CLASSIFIER] 결과: ${category}`);

  if (category === "talk") {
    try {
      const { callHaiku } = require("./claude");
      let prompt = message;
      if (userName) {
        prompt = `사용자 이름: ${userName}\n\n${prompt}`;
      }
      const answer = await callHaiku(TALK_SYSTEM_PROMPT, prompt);
      await say({ text: truncateForSlack(answer, 2000), thread_ts: threadTs });
    } catch (err) {
      console.error("[TALK] 답변 생성 실패:", err.message);
      await say({
        text: "답변 생성 중 오류가 발생했어요. 다시 시도해주세요!",
        thread_ts: threadTs,
      });
    }
    return;
  }

  if (category === "ask") {
    try {
      await ensureRepo();
      const threadData = threadBranchMap.get(threadTs);
      if (threadData) {
        await switchToBranch(threadData.branchName);
      }

      const repoPath = CONFIG.repo.path;
      const fileTree = collectFileTree(repoPath);
      const relevantPaths = await identifyRelevantFiles(message, fileTree, null);
      const fileContents = readFiles(relevantPaths, repoPath);

      const { callHaiku } = require("./claude");
      let prompt = message;
      if (fileContents.length > 0) {
        const filesContext = fileContents
          .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n");
        prompt = `## 질문\n${message}\n\n## 참고 파일\n${filesContext}`;
      }
      if (userName) {
        prompt = `사용자 이름: ${userName}\n\n${prompt}`;
      }
      const answer = await callHaiku(ASK_SYSTEM_PROMPT, prompt);
      await say({ text: truncateForSlack(answer, 2000), thread_ts: threadTs });
    } catch (err) {
      console.error("[ASK] 답변 생성 실패:", err.message);
      await say({
        text: "답변 생성 중 오류가 발생했어요. 다시 시도해주세요!",
        thread_ts: threadTs,
      });
    } finally {
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
    }
    return;
  }

  if (category === "unclear") {
    await say({ text: MESSAGES.UNCLEAR, thread_ts: threadTs });
    return;
  }

  // category === "code"
  const queuePosition = getQueueLength();
  if (queuePosition > 0) {
    await say({ text: MESSAGES.QUEUE(queuePosition), thread_ts: threadTs });
  }
  return enqueueRequest(() => _processCodeRequest(message, say, threadTs, userName));
}

async function _processCodeRequest(message, say, threadTs, userName) {
  try {
    // 1. 스레드 → 브랜치 매핑
    const existing = threadBranchMap.get(threadTs);
    const isFollowUp = !!existing;
    let branchName;

    const hasFigma = containsFigmaLink(message);
    const startMsg = hasFigma
      ? MESSAGES.START_FIGMA
      : isFollowUp
        ? MESSAGES.START_FOLLOWUP
        : MESSAGES.START_NEW;

    await say({ text: startMsg, thread_ts: threadTs });

    // 2. 레포 준비 & 브랜치 전환
    await ensureRepo();

    if (isFollowUp) {
      branchName = existing.branchName;
      try {
        await switchToBranch(branchName);
      } catch (err) {
        console.log(`[WARN] 기존 브랜치 전환 실패, 새로 생성: ${err.message}`);
        branchName = await createBranchName(message);
        await switchToBranch(branchName, true);
        threadBranchMap.set(threadTs, {
          branchName,
          hasCommit: false,
          changes: [],
        });
        saveThreadMap(threadBranchMap);
      }
    } else {
      branchName = await createBranchName(message);
      await switchToBranch(branchName, true);
      threadBranchMap.set(threadTs, {
        branchName,
        hasCommit: false,
        changes: [],
      });
      saveThreadMap(threadBranchMap);
    }

    // 3. 피그마 데이터 가져오기 (있으면)
    let figmaData = null;
    if (hasFigma) {
      if (!CONFIG.figma.apiKey) {
        await say({ text: MESSAGES.FIGMA_NO_KEY, thread_ts: threadTs });
      } else {
        try {
          figmaData = await fetchFigmaData(message);
          if (figmaData) {
            console.log(`[FIGMA] 디자인 스펙 ${figmaData.specs.length}건 추출`);
          }
        } catch (err) {
          console.error("[FIGMA] 데이터 가져오기 실패:", err.message);
          await say({ text: MESSAGES.FIGMA_FAILED, thread_ts: threadTs });
        }
      }
    }

    // 4. 파일 트리 수집 (fs, 즉시)
    const tmi = await generateTmi();
    const runningMsg = hasFigma
      ? MESSAGES.CLAUDE_RUNNING_FIGMA
      : MESSAGES.CLAUDE_RUNNING;
    await say({
      text: tmi ? `${runningMsg}\n\n${tmi}` : runningMsg,
      thread_ts: threadTs,
    });

    const repoPath = CONFIG.repo.path;
    console.log("[FILE-ANALYZER] 파일 트리 수집 중...");
    const fileTree = collectFileTree(repoPath);
    console.log(`[FILE-ANALYZER] 파일 ${fileTree.length}개 발견`);

    // 5. Haiku로 관련 파일 특정
    console.log("[FILE-ANALYZER] 관련 파일 특정 중...");
    const relevantPaths = await identifyRelevantFiles(
      message,
      fileTree,
      figmaData,
    );
    console.log(`[FILE-ANALYZER] 관련 파일 ${relevantPaths.length}개 특정`);

    // 6. 관련 파일 내용 읽기 (fs, 즉시)
    const fileContents = readFiles(relevantPaths, repoPath);
    console.log(`[FILE-ANALYZER] 파일 ${fileContents.length}개 읽기 완료`);

    // 7. 컨텍스트 구성
    const threadData = threadBranchMap.get(threadTs);
    const context = {
      isFollowUp,
      isFirstCommit: !threadData.hasCommit,
      previousChanges: isFollowUp ? threadData.changes.join("\n---\n") : null,
    };

    // 8. Sonnet으로 수정안 생성 (핵심)
    console.log("[CODE-GEN] 수정안 생성 중...");
    let changes;
    try {
      changes = await generateCodeChanges(
        message,
        fileContents,
        figmaData,
        context,
        repoPath,
      );
    } catch (err) {
      console.error("[CODE-GEN] 수정안 생성 실패:", err.message);
      await say({
        text: MESSAGES.CLAUDE_ERROR(truncateForSlack(err.message, 200)),
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    if (changes.length === 0) {
      await say({
        text: "수정할 내용을 찾지 못했어요. 좀 더 구체적으로 요청해주세요!",
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    // 9. 수정안 적용 + 실패한 edit 재시도
    console.log(`[BUILDER] 수정안 ${changes.length}건 적용 중...`);
    let applyResult = await applyChanges(changes, repoPath);
    let appliedChanges = [...applyResult.applied];

    console.log(
      `[BUILDER] 적용 ${applyResult.applied.length}건, 실패 ${applyResult.failed.length}건`,
    );

    // 실패한 edit이 있으면 파일 다시 읽혀서 Sonnet에게 재시도 요청 (최대 2회)
    if (applyResult.failed.length > 0) {
      for (let retryAttempt = 1; retryAttempt <= 2; retryAttempt++) {
        if (applyResult.failed.length === 0) break;

        console.log(`[BUILDER] 실패한 edit 재시도 ${retryAttempt}/2...`);
        const failedFiles = [...new Set(applyResult.failed.map((f) => f.change.filePath))];
        const failedFileContents = readFiles(failedFiles, repoPath);

        const failedSummary = applyResult.failed
          .map((f) => `파일: ${f.change.filePath}\n실패 원인: ${f.reason}\n의도한 수정: old_string을 new_string으로 교체`)
          .join("\n---\n");

        try {
          const retryRequest = `아래 edit이 실패했어. 현재 파일 내용을 보고 올바른 old_string으로 다시 수정해줘.\n\n원래 요청: ${message}\n\n## 실패한 수정\n${failedSummary}`;
          const retryChanges = await generateCodeChanges(
            retryRequest,
            failedFileContents,
            null,
            context,
            repoPath,
          );
          if (retryChanges.length > 0) {
            const retryResult = await applyChanges(retryChanges, repoPath);
            appliedChanges.push(...retryResult.applied);
            applyResult = { applied: retryResult.applied, failed: retryResult.failed };
            console.log(`[BUILDER] 재시도 적용 ${retryResult.applied.length}건, 실패 ${retryResult.failed.length}건`);
          } else {
            break;
          }
        } catch (err) {
          console.error("[BUILDER] 재시도 실패:", err.message);
          break;
        }
      }
    }

    if (appliedChanges.length === 0) {
      await say({
        text: "수정사항을 적용하지 못했어요. 다시 시도해주세요.",
        thread_ts: threadTs,
      });
      await revertChanges(repoPath);
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    // 10. 요청 대비 구현 완료 검증 (실제 적용된 changes 기준, 최대 2회 보완)
    for (let verifyAttempt = 1; verifyAttempt <= 2; verifyAttempt++) {
      console.log(`[VERIFY] 검증 시도 ${verifyAttempt}/2...`);
      const verification = await verifyChanges(message, appliedChanges);
      if (verification.passed) {
        console.log("[VERIFY] 검증 통과");
        break;
      }

      console.log(`[VERIFY] 누락 발견: ${verification.missing}`);
      if (verifyAttempt >= 2) {
        console.log("[VERIFY] 보완 횟수 초과, 현재 상태로 진행");
        break;
      }

      // 누락 사항을 Sonnet에게 보완 요청 — 현재 파일 상태를 다시 읽어서 전달
      console.log("[CODE-GEN] 누락 사항 보완 요청 중...");
      const appliedPaths = appliedChanges.map((c) => c.filePath);
      const allPaths = [...new Set([...relevantPaths, ...appliedPaths])];
      const currentFiles = readFiles(allPaths, repoPath);
      try {
        const supplementRequest = `원래 요청: ${message}\n\n이미 수정된 파일: ${appliedPaths.join(", ")}\n\n누락된 작업: ${verification.missing}\n\n누락된 부분만 추가로 구현해줘.`;
        const additionalChanges = await generateCodeChanges(
          supplementRequest,
          currentFiles,
          figmaData,
          context,
          repoPath,
        );
        if (additionalChanges.length > 0) {
          const addResult = await applyChanges(additionalChanges, repoPath);
          appliedChanges.push(...addResult.applied);
          console.log(`[VERIFY] 보완 적용 ${addResult.applied.length}건, 실패 ${addResult.failed.length}건`);
        }
      } catch (err) {
        console.error("[VERIFY] 보완 실패:", err.message);
      }
    }

    // 11. 빌드 검증 + 재시도 루프 (최대 3회)
    let buildResult;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[BUILDER] 빌드 시도 ${attempt}/3...`);
      buildResult = await runBuild(repoPath);
      if (buildResult.success) break;

      if (attempt < 3) {
        console.log("[CODE-GEN] 빌드 에러 수정 요청 중...");
        const appliedPaths = appliedChanges.map((c) => c.filePath);
        const allPaths = [...new Set([...relevantPaths, ...appliedPaths])];
        const currentFiles = readFiles(allPaths, repoPath);
        try {
          const fixes = await fixBuildError(
            buildResult.stderr,
            currentFiles,
            repoPath,
          );
          if (fixes.length > 0) {
            const fixResult = await applyChanges(fixes, repoPath);
            appliedChanges.push(...fixResult.applied);
          }
        } catch (err) {
          console.error("[CODE-GEN] 빌드 에러 수정 실패:", err.message);
        }
      }
    }

    if (!buildResult.success) {
      await revertChanges(repoPath);
      await say({
        text: MESSAGES.BUILD_FAILED(truncateForSlack(buildResult.stderr, 500)),
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    // 12. git commit + push
    console.log("[GIT] 커밋 & 푸시 중...");
    const changedFiles = [...new Set(appliedChanges.map((c) => c.filePath))];
    try {
      await run(`git add ${changedFiles.map((f) => `"${f}"`).join(" ")}`, repoPath);
    } catch {
      await run("git add -A", repoPath);
    }

    // Haiku로 커밋 메시지 생성
    const { callHaiku } = require("./claude");
    let commitMsg;
    try {
      const changeSummaryForCommit = changedFiles.join(", ");
      commitMsg = await callHaiku(
        `너는 git 커밋 메시지 생성기야. design: 접두사로 시작하는 한국어 커밋 메시지를 한 줄로 작성해. 50자 이내. 커밋 메시지만 출력해.`,
        `요청: ${message}\n수정된 파일: ${changeSummaryForCommit}`,
      );
      commitMsg = commitMsg.trim().replace(/"/g, '\\"');
    } catch {
      commitMsg = `design: ${message.slice(0, 50).replace(/"/g, '\\"')}`;
    }
    await run(`git commit -m "${commitMsg}"`, repoPath);
    await run(`git push origin ${branchName}`, repoPath);
    const pushTimestamp = Date.now();

    // 13. 스레드 데이터 업데이트
    threadData.hasCommit = true;
    threadData.changes.push(
      appliedChanges
        .map((c) => `${c.type}: ${c.filePath}`)
        .join("\n")
        .slice(0, 500),
    );
    saveThreadMap(threadBranchMap);

    // 14. Vercel 프리뷰 URL 대기
    await say({ text: MESSAGES.VERCEL_WAITING, thread_ts: threadTs });
    const vercelUrl = await waitForVercelDeployment(branchName, pushTimestamp);

    // 15. 결과 요약 생성 (파일 경로 + 변경 내용 포함)
    const changeSummary = appliedChanges
      .map((c) => {
        if (c.type === "create") {
          const preview = (c.content || "").slice(0, 200);
          return `생성: ${c.filePath}\n내용 미리보기: ${preview}`;
        } else {
          return `수정: ${c.filePath}\n이전: ${(c.oldString || "").slice(0, 100)}\n이후: ${(c.newString || "").slice(0, 100)}`;
        }
      })
      .join("\n---\n");
    const summaryInput = `## 원래 요청\n${message}\n\n## 변경 내역\n${changeSummary}`;
    const summary =
      (await summarizeChanges(summaryInput)) || changeSummary;

    // 16. 슬랙 응답
    const statusEmoji = isFollowUp ? "🔄" : "✅";
    const namePrefix = userName ? `${userName}님, ` : "";
    const statusText = isFollowUp ? `${namePrefix}추가 수정 완료!` : `${namePrefix}수정 완료!`;
    const resultParts = [`${statusEmoji} ${statusText}`, "", summary];

    if (vercelUrl) {
      resultParts.push("", `🌐 프리뷰: ${vercelUrl}`);
    }

    resultParts.push(
      "",
      vercelUrl
        ? MESSAGES.RESULT_FOOTER_WITH_PREVIEW
        : MESSAGES.RESULT_FOOTER,
    );

    await say({
      text: resultParts.join("\n"),
      thread_ts: threadTs,
    });

    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
  } catch (error) {
    console.error("[ERROR]", error);

    let errorMsg = MESSAGES.GENERIC_ERROR(
      truncateForSlack(error.message, 200),
    );

    if (
      error.message.includes("Authentication") ||
      error.message.includes("403")
    ) {
      errorMsg = MESSAGES.AUTH_ERROR;
    } else if (
      error.message.includes("CONFLICT") ||
      error.message.includes("merge")
    ) {
      errorMsg = MESSAGES.CONFLICT_ERROR;
    } else if (
      error.message.includes("disk") ||
      error.message.includes("No space")
    ) {
      errorMsg = MESSAGES.DISK_ERROR;
    }

    await say({ text: errorMsg, thread_ts: threadTs });

    try {
      await run("git reset --hard HEAD");
      await run(`git checkout ${CONFIG.repo.branch}`);
    } catch {}
  }
}

async function processPrRequest(say, threadTs) {
  const threadData = threadBranchMap.get(threadTs);

  if (!threadData || !threadData.hasCommit) {
    await say({ text: MESSAGES.NO_COMMIT, thread_ts: threadTs });
    return;
  }

  const { branchName } = threadData;

  try {
    await say({ text: MESSAGES.PR_CREATING, thread_ts: threadTs });
    await ensureRepo();
    await switchToBranch(branchName);

    // git log로 커밋 이력 가져오기
    const gitLog = await run(
      `git log ${CONFIG.repo.branch}..HEAD --pretty=format:"%s"`,
      CONFIG.repo.path,
    );

    // Haiku로 PR 제목 + 본문 생성
    const { callHaiku } = require("./claude");
    let prTitle, prBody;
    try {
      const prContent = await callHaiku(
        `너는 GitHub PR 작성기야. 디자인 수정 PR을 작성해.

출력 형식 (정확히 따라):
TITLE: design: [한국어 제목 50자 이내]
BODY:
## Summary
- [변경사항 1]
- [변경사항 2]

## Changed Files
- [파일 목록]

다른 텍스트 없이 위 형식만 출력해.`,
        `브랜치: ${branchName}\n커밋 이력:\n${gitLog}\n\n변경 파일:\n${threadData.changes.join("\n")}`,
      );
      const titleMatch = prContent.match(/TITLE:\s*(.+)/);
      const bodyMatch = prContent.match(/BODY:\s*([\s\S]+)/);
      prTitle = titleMatch ? titleMatch[1].trim() : `design: ${branchName.replace("design/", "")}`;
      prBody = bodyMatch ? bodyMatch[1].trim() : threadData.changes.join("\n");
    } catch {
      prTitle = `design: ${branchName.replace("design/", "")}`;
      prBody = threadData.changes.join("\n");
    }

    // PR body를 레포 밖 임시 파일로 저장 (git에 안 잡히게)
    const fs = require("fs");
    const prBodyPath = path.join("/tmp", "design-bot-pr-body.tmp");
    fs.writeFileSync(prBodyPath, prBody, "utf-8");
    const safeTitle = prTitle.replace(/"/g, '\\"').replace(/`/g, "\\`");

    let prUrl;
    try {
      // 이미 PR이 있는지 확인
      const existingPr = await run(
        `gh pr view ${branchName} --json url --jq .url`,
        CONFIG.repo.path,
      );
      if (existingPr && existingPr.includes("github.com")) {
        prUrl = existingPr.trim();
        console.log(`[PR] 기존 PR 발견: ${prUrl}`);
      }
    } catch {
      // PR 없음 → 새로 생성
    }

    if (!prUrl) {
      const prOutput = await run(
        `gh pr create --title "${safeTitle}" --body-file ${prBodyPath} --base ${CONFIG.repo.branch} --draft`,
        CONFIG.repo.path,
      );
      const prUrlMatch = prOutput.match(
        /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/,
      );
      prUrl = prUrlMatch ? prUrlMatch[0] : null;
    }
    fs.unlinkSync(prBodyPath);

    const resultParts = ["✅ PR 생성 완료!"];
    if (prUrl) resultParts.push(`🔗 PR: ${prUrl}`);

    await say({ text: resultParts.join("\n"), thread_ts: threadTs });
    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
  } catch (error) {
    console.error("[PR ERROR]", error);
    await say({
      text: MESSAGES.PR_ERROR(truncateForSlack(error.message, 200)),
      thread_ts: threadTs,
    });
    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
  }
}

module.exports = { processRequest, processPrRequest };
