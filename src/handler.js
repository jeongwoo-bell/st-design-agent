const { CONFIG } = require("./config");
const { MESSAGES } = require("./messages");
const { run, ensureRepo, switchToBranch } = require("./git");
const { runClaudeCode, runClaudeChat } = require("./claude");
const { threadBranchMap, saveThreadMap } = require("./thread-map");
const { enqueueRequest, getQueueLength } = require("./queue");
const {
  truncateForSlack,
  createBranchName,
  parseClaudeOutput,
  containsFigmaLink,
} = require("./parser");
const { waitForVercelDeployment } = require("./vercel");
const {
  classifyMessage,
  generateTmi,
  summarizeChanges,
} = require("./classifier");

async function processRequest(message, say, threadTs) {
  // Haiku로 분류 (새 요청이든 후속이든 동일)
  console.log("[CLASSIFIER] 메시지 분류 중...");
  const category = await classifyMessage(message);
  console.log(`[CLASSIFIER] 결과: ${category}`);

  if (category === "chat") {
    const chatTmi = await generateTmi();
    const chatMsg = "💬 코드를 확인하고 답변할게요...";
    await say({
      text: chatTmi ? `${chatMsg}\n\n${chatTmi}` : chatMsg,
      thread_ts: threadTs,
    });
    try {
      await ensureRepo();
      // 기존 스레드면 해당 브랜치에서 코드를 읽어야 정확한 답변 가능
      const threadData = threadBranchMap.get(threadTs);
      if (threadData) {
        await switchToBranch(threadData.branchName);
      }
      const answer = await runClaudeChat(message);
      await say({ text: truncateForSlack(answer, 2000), thread_ts: threadTs });
    } catch (err) {
      console.error("[CHAT] Claude Code 실패:", err.message);
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
    await say({
      text: MESSAGES.UNCLEAR,
      thread_ts: threadTs,
    });
    return;
  }

  // category === "code"
  const queuePosition = getQueueLength();
  if (queuePosition > 0) {
    await say({
      text: MESSAGES.QUEUE(queuePosition),
      thread_ts: threadTs,
    });
  }
  return enqueueRequest(() => _processRequest(message, say, threadTs));
}

async function _processRequest(message, say, threadTs) {
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

    if (hasFigma && !CONFIG.figma.apiKey) {
      await say({
        text: MESSAGES.FIGMA_NO_KEY,
        thread_ts: threadTs,
      });
    }

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

    // 3. Claude Code 실행
    const tmi = await generateTmi();
    const runningMsg = hasFigma
      ? MESSAGES.CLAUDE_RUNNING_FIGMA
      : MESSAGES.CLAUDE_RUNNING;
    await say({
      text: tmi ? `${runningMsg}\n\n${tmi}` : runningMsg,
      thread_ts: threadTs,
    });

    const threadData = threadBranchMap.get(threadTs);
    const isFirstCommit = !threadData.hasCommit;
    const context = {
      isFollowUp,
      isFirstCommit,
      previousChanges: isFollowUp ? threadData.changes.join("\n---\n") : null,
    };

    let claudeOutput;
    try {
      claudeOutput = await runClaudeCode(message, context);
    } catch (err) {
      if (err.message.includes("타임아웃")) {
        await say({
          text: MESSAGES.TIMEOUT,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: MESSAGES.CLAUDE_ERROR(truncateForSlack(err.message, 200)),
          thread_ts: threadTs,
        });
      }
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    // 4. Claude 출력 분석
    const { status } = parseClaudeOutput(claudeOutput);

    if (status === "not_code") {
      await say({
        text: MESSAGES.NOT_CODE,
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    if (status === "not_found") {
      await say({
        text: MESSAGES.NOT_FOUND(truncateForSlack(claudeOutput, 1000)),
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    if (status === "build_failed") {
      await say({
        text: MESSAGES.BUILD_FAILED(truncateForSlack(claudeOutput, 1000)),
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    if (status === "figma_failed") {
      await say({
        text: MESSAGES.FIGMA_FAILED,
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    // 5. 성공 - 변경 이력 업데이트
    threadData.changes.push(claudeOutput.slice(0, 500));
    threadData.hasCommit = true;
    saveThreadMap(threadBranchMap);

    // 6. Vercel 프리뷰 URL 대기
    await say({
      text: MESSAGES.VERCEL_WAITING,
      thread_ts: threadTs,
    });
    const vercelUrl = await waitForVercelDeployment(branchName);

    // 7. 결과 알림
    const statusEmoji = isFollowUp ? "🔄" : "✅";
    const statusText = isFollowUp ? "추가 수정 완료!" : "수정 완료!";

    const summary =
      (await summarizeChanges(claudeOutput)) ||
      truncateForSlack(claudeOutput, 500);

    const resultParts = [`${statusEmoji} ${statusText}`, "", summary];

    if (vercelUrl) {
      resultParts.push("", `🌐 프리뷰: ${vercelUrl}`);
    }

    resultParts.push(
      "",
      vercelUrl ? MESSAGES.RESULT_FOOTER_WITH_PREVIEW : MESSAGES.RESULT_FOOTER,
    );

    await say({
      text: resultParts.join("\n"),
      thread_ts: threadTs,
    });

    // develop으로 복귀
    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
  } catch (error) {
    console.error("[ERROR]", error);

    let errorMsg = MESSAGES.GENERIC_ERROR(truncateForSlack(error.message, 200));

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
    await say({
      text: MESSAGES.NO_COMMIT,
      thread_ts: threadTs,
    });
    return;
  }

  const { branchName } = threadData;

  try {
    await say({
      text: MESSAGES.PR_CREATING,
      thread_ts: threadTs,
    });

    await ensureRepo();
    await switchToBranch(branchName);

    // Claude Code로 /pr 스킬 실행
    const { runClaudeCode } = require("./claude");
    const prPrompt = `
이 브랜치(${branchName})의 변경사항을 기반으로 /pr 스킬을 사용해서 Draft PR을 생성해.
- base 브랜치: ${CONFIG.repo.branch}
- Draft 모드로 생성
- PR 제목과 본문은 변경사항(git diff, git log)을 분석해서 자동 생성
- PR URL을 반드시 출력해

출력 형식:
🔗 PR: [PR URL]
`;
    const claudeOutput = await runClaudeCode(prPrompt, {});
    const { extractPrUrl } = require("./parser");
    const prUrl = extractPrUrl(claudeOutput);

    // Vercel 프리뷰 URL도 함께
    const vercelUrl = await waitForVercelDeployment(branchName);

    const resultParts = ["✅ PR 생성 완료!"];

    if (prUrl) {
      resultParts.push(`🔗 PR: ${prUrl}`);
    }

    if (vercelUrl) {
      resultParts.push(`🌐 프리뷰: ${vercelUrl}`);
    }

    if (!prUrl) {
      resultParts.push(
        "",
        "📋 Claude 출력:",
        "```",
        truncateForSlack(claudeOutput, 1500),
        "```",
      );
    }

    await say({
      text: resultParts.join("\n"),
      thread_ts: threadTs,
    });

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
