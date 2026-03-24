const { CONFIG } = require("./config");
const { run, ensureRepo, switchToBranch } = require("./git");
const { runClaudeCode } = require("./claude");
const { threadBranchMap, saveThreadMap } = require("./thread-map");
const { enqueueRequest, getQueueLength } = require("./queue");
const {
  truncateForSlack,
  createBranchName,
  parseClaudeOutput,
  extractPrUrl,
  containsFigmaLink,
} = require("./parser");
const { waitForVercelDeployment } = require("./vercel");

async function processRequest(message, say, threadTs) {
  const queuePosition = getQueueLength();
  if (queuePosition > 0) {
    await say({
      text: `⏳ 앞에 ${queuePosition}개 요청이 있어요. 순서대로 처리할게요!`,
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
      ? "🎨 피그마 링크를 감지했어요! 디자인 분석 후 구현할게요..."
      : isFollowUp
        ? "🔧 같은 브랜치에서 이어서 수정할게요..."
        : "🔧 요청을 받았어요! 브랜치 생성 중...";

    await say({ text: startMsg, thread_ts: threadTs });

    if (hasFigma && !CONFIG.figma.apiKey) {
      await say({
        text: "⚠️ 피그마 MCP가 설정되어 있지 않아요. 관리자에게 FIGMA_API_KEY 설정을 요청해주세요!\n텍스트로 수정 내용을 설명해주시면 그걸로 진행할게요.",
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
        branchName = createBranchName(message);
        await switchToBranch(branchName, true);
        threadBranchMap.set(threadTs, {
          branchName,
          hasCommit: false,
          changes: [],
        });
        saveThreadMap(threadBranchMap);
      }
    } else {
      branchName = createBranchName(message);
      await switchToBranch(branchName, true);
      threadBranchMap.set(threadTs, {
        branchName,
        hasCommit: false,
        changes: [],
      });
      saveThreadMap(threadBranchMap);
    }

    // 3. Claude Code 실행
    await say({
      text: hasFigma
        ? "🤖 Claude Code가 피그마 디자인을 분석하고 구현 중이에요..."
        : "🤖 Claude Code가 코드를 수정하고 있어요...\n(수정 → 빌드 검증 → 커밋 → 푸시까지 자동으로 진행돼요)",
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
          text: "⏰ 작업이 너무 오래 걸려서 중단됐어요. 요청을 더 작게 나눠서 다시 시도해주세요!",
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `❌ Claude Code 실행 중 오류: ${truncateForSlack(err.message, 200)}`,
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
        text: "🤔 코드 수정 요청이 아닌 것 같아요. 수정할 내용을 알려주세요!\n예: `Section3 타이틀 폰트 크기 키워줘`",
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    if (status === "not_found") {
      await say({
        text: `🔍 수정할 대상을 찾지 못했어요.\n\n${truncateForSlack(claudeOutput, 1000)}\n\n좀 더 구체적으로 알려주시면 다시 시도할게요!`,
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    if (status === "build_failed") {
      await say({
        text: `🔨 빌드가 실패해서 수정을 되돌렸어요.\n\n${truncateForSlack(claudeOutput, 1000)}\n\n다른 방식으로 요청해주시면 다시 시도할게요!`,
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    if (status === "figma_failed") {
      await say({
        text: "🎨 피그마 디자인 데이터를 가져오지 못했어요.\n텍스트로 수정 내용을 설명해주시면 바로 반영할게요!\n예: `Section3 타이틀 32px, bold, 흰색으로 바꿔줘`",
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    // 5. 성공 - 변경 이력 업데이트
    threadData.changes.push(claudeOutput.slice(0, 500));
    threadData.hasCommit = true;
    saveThreadMap(threadBranchMap);

    const prUrl = extractPrUrl(claudeOutput);

    // 6. Vercel 프리뷰 URL 대기
    await say({
      text: "🚀 Vercel 배포 대기 중...",
      thread_ts: threadTs,
    });
    const vercelUrl = await waitForVercelDeployment(branchName);

    // 7. 결과 알림
    const commitCount = threadData.changes.length;
    const statusEmoji = isFollowUp ? "🔄" : "✅";
    const statusText = isFollowUp
      ? `추가 수정 완료! (이 스레드 ${commitCount}번째 수정)`
      : "코드 수정 완료!";

    const resultParts = [
      `${statusEmoji} ${statusText}`,
      "",
      `📌 브랜치: \`${branchName}\``,
    ];

    if (prUrl) {
      resultParts.push(`🔗 PR: ${prUrl}`);
    }

    if (vercelUrl) {
      resultParts.push(`🌐 프리뷰: ${vercelUrl}`);
    }

    resultParts.push(
      "",
      "📋 수정 내역:",
      "```",
      truncateForSlack(claudeOutput, 1500),
      "```",
      "",
      vercelUrl
        ? "위 프리뷰 링크에서 확인해주세요! 추가 수정이 필요하면 이 스레드에서 말씀해주세요."
        : "추가 수정이 필요하면 이 스레드에서 말씀해주세요.",
    );

    await say({
      text: resultParts.join("\n"),
      thread_ts: threadTs,
    });

    // develop으로 복귀
    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
  } catch (error) {
    console.error("[ERROR]", error);

    let errorMsg = `❌ 에러가 발생했어요: ${truncateForSlack(error.message, 200)}`;

    if (
      error.message.includes("Authentication") ||
      error.message.includes("403")
    ) {
      errorMsg = "🔑 GitHub 인증에 문제가 있어요. 관리자에게 알려주세요!";
    } else if (
      error.message.includes("CONFLICT") ||
      error.message.includes("merge")
    ) {
      errorMsg = "⚠️ Git 충돌이 발생했어요. 개발팀에 알려주세요!";
    } else if (
      error.message.includes("disk") ||
      error.message.includes("No space")
    ) {
      errorMsg = "💾 서버 디스크 용량이 부족해요. 관리자에게 알려주세요!";
    }

    await say({ text: errorMsg, thread_ts: threadTs });

    try {
      await run("git reset --hard HEAD");
      await run(`git checkout ${CONFIG.repo.branch}`);
    } catch {}
  }
}

module.exports = { processRequest };
