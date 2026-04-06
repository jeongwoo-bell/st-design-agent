// ============================================
// v5 오케스트레이터 — 봇이 전체 흐름을 직접 제어
// ============================================
const path = require("path");
const { CONFIG } = require("./config");
const { MESSAGES } = require("./messages");
const { run, ensureRepo, ensureDocsRepo, switchToBranch } = require("./git");
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
  summarizeChanges,
  verifyChanges,
  matchTickets,
} = require("./classifier");
const { fetchOpenTickets, fetchActionableTickets } = require("./jira");
const { ProgressTracker } = require("./progress");
const { collectFileTree, identifyRelevantFiles, readFiles } = require("./file-analyzer");
const { fetchFigmaData } = require("./figma");
const { generateCodeChanges, fixBuildError } = require("./code-generator");
const { applyChanges, runBuild, revertChanges } = require("./builder");
const { buildDocsContext } = require("./docs-reader");
const { WebClient } = require("@slack/web-api");
const slackClient = new WebClient(CONFIG.slack.botToken);

// 티켓 선택 대기 상태 (messageTs → { tickets, selected, message, ... })
const pendingTicketSelections = new Map();

// 피그마 링크 대기 상태 (messageTs → { enrichedMessage, say, threadTs, ... })
const pendingFigmaSelections = new Map();

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

async function getThreadHistory(channel, threadTs) {
  try {
    const result = await slackClient.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });
    if (!result.messages || result.messages.length <= 1) return null;

    // 현재 메시지(마지막) 제외
    const allMessages = result.messages.slice(0, -1);

    // 첫 메시지(원래 요청) + 최근 8개로 구성
    // 긴 스레드에서도 원래 맥락 + 최근 흐름을 모두 파악 가능
    let selected;
    if (allMessages.length <= 10) {
      selected = allMessages;
    } else {
      const first = allMessages[0];
      const recent = allMessages.slice(-8);
      selected = [first, { text: `... (중간 ${allMessages.length - 9}개 메시지 생략) ...` }, ...recent];
    }

    const history = selected.map((msg) => {
      const role = msg.bot_id ? "봇" : "유저";
      const text = (msg.text || "").replace(/<@[A-Z0-9]+>/g, "").trim().slice(0, 300);
      return `${role}: ${text}`;
    });
    return history.join("\n");
  } catch (err) {
    console.warn("[THREAD] 히스토리 조회 실패:", err.message);
    return null;
  }
}

async function processRequest(message, say, threadTs, channel, messageTs, userId) {
  // 👀 리액션으로 확인 표시 + 유저 이름 가져오기 (병렬)
  const [, userName] = await Promise.all([
    channel && messageTs ? addReaction(channel, messageTs, "eyes") : Promise.resolve(),
    userId ? getUserName(userId) : Promise.resolve(null),
  ]);

  // 스레드 히스토리 가져오기 (분류 정확도 향상용)
  const threadHistory = await getThreadHistory(channel, threadTs);

  // Haiku로 분류
  console.log("[CLASSIFIER] 메시지 분류 중...");
  const category = await classifyMessage(message, threadHistory);
  console.log(`[CLASSIFIER] 결과: ${category}`);

  if (category === "talk") {
    try {
      const { callHaiku } = require("./claude");
      let prompt = message;
      if (threadHistory) {
        prompt = `## 스레드 이전 대화\n${threadHistory}\n\n## 현재 메시지\n${prompt}`;
      }
      if (userName) {
        prompt = `사용자 이름: ${userName}\n\n${prompt}`;
      }
      const answer = await callHaiku(TALK_SYSTEM_PROMPT, prompt);
      await say({ text: truncateForSlack(answer, 2000), thread_ts: threadTs });
    } catch (err) {
      console.error("[TALK] 답변 생성 실패:", err.message);
      await say({
        text: MESSAGES.ANSWER_ERROR,
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
      if (threadHistory) {
        prompt = `## 스레드 이전 대화\n${threadHistory}\n\n${prompt}`;
      }
      if (userName) {
        prompt = `사용자 이름: ${userName}\n\n${prompt}`;
      }
      const answer = await callHaiku(ASK_SYSTEM_PROMPT, prompt);
      await say({ text: truncateForSlack(answer, 2000), thread_ts: threadTs });
    } catch (err) {
      console.error("[ASK] 답변 생성 실패:", err.message);
      await say({
        text: MESSAGES.ANSWER_ERROR,
        thread_ts: threadTs,
      });
    } finally {
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
    }
    return;
  }

  if (category === "ticket") {
    try {
      console.log("[JIRA] 티켓 조회 중...");
      const tickets = await fetchOpenTickets();
      if (tickets.length === 0) {
        await say({ text: MESSAGES.TICKET_EMPTY, thread_ts: threadTs });
        return;
      }

      // Haiku로 사용자 요청에 맞는 티켓 요약 생성
      const { callHaiku } = require("./claude");
      const ticketList = tickets
        .map((t) => `${t.key} | ${t.summary} | ${t.status} | ${t.assignee}`)
        .join("\n");

      let prompt = `## 사용자 요청\n${message}\n\n## JIRA 티켓 목록 (미완료)\n${ticketList}`;
      if (userName) {
        prompt = `사용자 이름: ${userName}\n\n${prompt}`;
      }

      const answer = await callHaiku(
        `너는 JIRA 티켓 현황을 알려주는 봇이야. 사용자의 질문에 맞게 티켓 목록을 정리해서 알려줘.

## 상태별 의미
- "Idea" = 아직 시작 안 한 티켓. 앞으로 해야 할 것
- "해야 할 일" = 할당됐지만 아직 시작 안 함
- "진행 중" = 현재 작업 중
- "테스트" = 이미 구현 완료, QA/검증 대기 중. 더 이상 개발 작업이 필요 없음

## 규칙
- 한국어로 답변
- 사용자 이름이 주어지면 "OO님, ..." 으로 시작
- 슬랙 mrkdwn 형식 (마크다운 헤더 # 쓰지 마)
- 티켓을 상태별로 그룹핑해서 보여줘
- 각 티켓은 "• [SCRUM-123] 티켓 제목 (담당: 이름)" 형식
- 사용자가 "내 할 일", "처리해야 할 것"을 물으면 → Idea와 해야 할 일 상태만 보여줘 (테스트/진행 중은 이미 처리된 것)
- 사용자가 "전체", "현황", "모든 티켓"을 물으면 → 전체 보여줘
- 사용자가 특정 상태를 물으면 ("IDEA 티켓", "테스트 중인 거") → 해당 상태만
- 사용자가 "내 할 일"을 물으면 해당 사용자에게 배정된 티켓만 필터링
- 간결하게, 핵심만`,
        prompt,
      );

      await say({ text: truncateForSlack(answer, 3000), thread_ts: threadTs });
    } catch (err) {
      console.error("[TICKET] 티켓 조회 실패:", err.message);
      await say({
        text: MESSAGES.TICKET_QUERY_ERROR,
        thread_ts: threadTs,
      });
    }
    return;
  }

  if (category === "unclear") {
    await say({ text: MESSAGES.UNCLEAR, thread_ts: threadTs });
    return;
  }

  // category === "code"
  // JIRA 티켓 매칭
  const jiraEnabled = CONFIG.jira.host && CONFIG.jira.apiToken;
  if (jiraEnabled) {
    console.log("[JIRA] 티켓 조회 중...");
    const allTickets = await fetchActionableTickets();
    if (allTickets.length > 0) {
      const matched = await matchTickets(message, threadHistory, allTickets);
      if (matched.length > 0) {
        // 이모지 풀: 1~9 + 컬러 이모지
        const DISPLAY_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣",
          "🔴", "🟡", "🟢", "🔵", "🟣", "🟠", "🟤", "⚫", "⚪", "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤"];
        const REACTION_NAMES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
          "red_circle", "large_yellow_circle", "large_green_circle", "large_blue_circle", "purple_circle",
          "large_orange_circle", "large_brown_circle", "black_circle", "white_circle",
          "heart", "orange_heart", "yellow_heart", "green_heart", "blue_heart", "purple_heart", "black_heart"];

        const ticketCount = Math.min(matched.length, DISPLAY_EMOJIS.length);
        const ticketLines = matched.slice(0, ticketCount).map((t, i) =>
          `${DISPLAY_EMOJIS[i]}  ${t.key} — ${t.summary} (${t.status})`,
        );
        const ticketMsg = [
          "🎫 요청과 관련된 JIRA 티켓을 찾았어요!",
          "",
          ...ticketLines,
          "",
          "처리할 티켓 이모지를 누른 뒤 ✅ 를 눌러주세요!",
        ].join("\n");

        const ticketMsgResult = await slackClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: ticketMsg,
        });

        // 봇이 이모지 미리 달기
        for (let i = 0; i < ticketCount; i++) {
          await addReaction(channel, ticketMsgResult.ts, REACTION_NAMES[i]);
        }
        await addReaction(channel, ticketMsgResult.ts, "white_check_mark");

        // 대기 상태 저장 — reaction_added에서 확인용
        pendingTicketSelections.set(ticketMsgResult.ts, {
          tickets: matched.slice(0, ticketCount),
          reactionNames: REACTION_NAMES.slice(0, ticketCount),
          selected: new Set(),
          message,
          threadTs,
          channel,
          userName,
          threadHistory,
          userId,
        });

        console.log(`[JIRA] ${ticketCount}개 티켓 매칭, 유저 선택 대기 중`);
        return;
      }
    }
  }

  // 티켓 없이 바로 처리
  const queuePosition = getQueueLength();
  if (queuePosition > 0) {
    await say({ text: MESSAGES.QUEUE(queuePosition), thread_ts: threadTs });
  }
  return enqueueRequest(() => _processCodeRequest(message, say, threadTs, userName, channel, threadHistory));
}

async function _processCodeRequest(message, say, threadTs, userName, channel, threadHistory, selectedTickets) {
  try {
    // 1. 스레드 → 브랜치 매핑
    const existing = threadBranchMap.get(threadTs);
    const isFollowUp = !!existing;
    let branchName;

    const hasFigma = containsFigmaLink(message);

    // 진행상황 트래커 설정
    const progress = new ProgressTracker(channel, threadTs);
    if (hasFigma) progress.addStep("피그마 디자인 분석");
    const STEP_BRANCH = progress.addStep("브랜치 준비");
    const STEP_FIGMA = hasFigma ? 0 : null;
    const STEP_DOCS = CONFIG.docs.url ? progress.addStep("스펙 문서 분석") : null;
    const STEP_ANALYZE = progress.addStep("관련 파일 분석");
    const STEP_CODEGEN = progress.addStep("코드 수정");
    const STEP_BUILD = progress.addStep("빌드 검증");
    const STEP_PUSH = progress.addStep("커밋 & 푸시");
    const STEP_DEPLOY = progress.addStep("Vercel 배포");
    await progress.post();

    await progress.start(STEP_BRANCH);

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
    await progress.done(STEP_BRANCH);

    // 3. 피그마 데이터 가져오기 (있으면)
    let figmaData = null;
    if (hasFigma) {
      await progress.start(STEP_FIGMA);
      if (!CONFIG.figma.apiKey) {
        await progress.fail(STEP_FIGMA, "피그마 API 키 미설정");
        await say({ text: MESSAGES.FIGMA_NO_KEY, thread_ts: threadTs });
      } else {
        try {
          figmaData = await fetchFigmaData(message);
          if (figmaData) {
            console.log(`[FIGMA] 디자인 스펙 ${figmaData.specs.length}건 추출`);
            await progress.done(STEP_FIGMA, `피그마 디자인 분석 완료 (${figmaData.specs.length}건)`);
          } else {
            await progress.done(STEP_FIGMA);
          }
        } catch (err) {
          console.error("[FIGMA] 데이터 가져오기 실패:", err.message);
          await progress.fail(STEP_FIGMA, "피그마 데이터 가져오기 실패");
          await say({ text: MESSAGES.FIGMA_FAILED, thread_ts: threadTs });
        }
      }
    }

    // 4. 파일 트리 수집 (fs, 즉시)
    await progress.start(STEP_ANALYZE);

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
    await progress.done(STEP_ANALYZE, `관련 파일 분석 완료 (${fileContents.length}개 파일)`);

    // 7. docs 스펙 문서 분석 (설정되어 있으면)
    let docsResult = null;
    if (CONFIG.docs.url && STEP_DOCS !== null) {
      await progress.start(STEP_DOCS);
      try {
        const docsReady = await ensureDocsRepo();
        if (docsReady) {
          docsResult = await buildDocsContext(message, fileContents);
          if (docsResult) {
            if (docsResult.implStatus.status === "implemented") {
              await progress.done(STEP_DOCS, "이미 구현됨 — 확인 완료");
              await say({
                text: MESSAGES.ALREADY_IMPLEMENTED(docsResult.specIds, docsResult.implStatus.implemented),
                thread_ts: threadTs,
              });
              await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
              return;
            }
            const statusLabel = docsResult.implStatus.status === "partial" ? "부분 구현" : "미구현";
            await progress.done(STEP_DOCS, `스펙 분석 완료 (${docsResult.specIds.join(", ")}) — ${statusLabel}`);
          } else {
            await progress.done(STEP_DOCS, "관련 스펙 없음");
          }
        } else {
          await progress.fail(STEP_DOCS, "docs 레포 접근 실패");
        }
      } catch (err) {
        console.error("[DOCS] docs 분석 실패:", err.message);
        await progress.fail(STEP_DOCS, "스펙 분석 실패");
      }
    }

    // 8. 컨텍스트 구성
    const threadData = threadBranchMap.get(threadTs);
    const context = {
      isFollowUp,
      isFirstCommit: !threadData.hasCommit,
      previousChanges: isFollowUp ? threadData.changes.join("\n---\n") : null,
      threadHistory: threadHistory || null,
      docsContext: docsResult?.docsContext || null,
    };

    // 9. Sonnet으로 수정안 생성 (핵심)
    await progress.start(STEP_CODEGEN);
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
      await progress.fail(STEP_CODEGEN, "코드 수정 실패");
      await say({
        text: MESSAGES.CLAUDE_ERROR(truncateForSlack(err.message, 200)),
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    if (changes.length === 0) {
      await progress.fail(STEP_CODEGEN, "수정할 내용 없음");
      await say({
        text: MESSAGES.NO_CHANGES,
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
      await progress.fail(STEP_CODEGEN, "수정사항 적용 실패");
      await say({
        text: MESSAGES.APPLY_FAILED,
        thread_ts: threadTs,
      });
      await revertChanges(repoPath);
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }

    const changedFileCount = [...new Set(appliedChanges.map((c) => c.filePath))].length;
    await progress.done(STEP_CODEGEN, `코드 수정 완료 (${changedFileCount}개 파일)`);

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
    await progress.start(STEP_BUILD);
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
      await progress.fail(STEP_BUILD, "빌드 실패");
      await revertChanges(repoPath);
      await say({
        text: MESSAGES.BUILD_FAILED(truncateForSlack(buildResult.stderr, 500)),
        thread_ts: threadTs,
      });
      await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
      return;
    }
    await progress.done(STEP_BUILD);

    // 12. git commit + push
    await progress.start(STEP_PUSH);
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
    await progress.done(STEP_PUSH);

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
    await progress.start(STEP_DEPLOY);
    const vercelUrl = await waitForVercelDeployment(branchName, pushTimestamp);
    await progress.done(STEP_DEPLOY, vercelUrl ? "Vercel 배포 완료" : "Vercel 배포 스킵");

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
    const namePrefix = userName ? `${userName}님, ` : "";
    const doneTitle = isFollowUp ? `✅ ${namePrefix}추가 수정 완료!` : `✅ ${namePrefix}수정 완료!`;
    await progress.finish(doneTitle);

    const resultParts = [summary];

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

/**
 * 리액션 이벤트 처리 — 티켓 선택 확정
 */
async function handleReaction(event, say) {
  const { reaction, item } = event;
  const msgTs = item.ts;

  // 피그마 링크 대기 처리
  const figmaPending = pendingFigmaSelections.get(msgTs);
  if (figmaPending) {
    if (reaction === "white_check_mark") {
      pendingFigmaSelections.delete(msgTs);
      // 스레드에서 피그마 링크 찾기
      const threadHistory = await getThreadHistory(figmaPending.channel, figmaPending.threadTs);
      const figmaLink = containsFigmaLink(threadHistory || "");
      if (!figmaLink) {
        await say({
          text: MESSAGES.FIGMA_LINK_MISSING,
          thread_ts: figmaPending.threadTs,
        });
        // 다시 대기 상태로
        pendingFigmaSelections.set(msgTs, figmaPending);
        return;
      }
      // 피그마 링크를 메시지에 포함
      const enrichedWithFigma = figmaPending.enrichedMessage + `\n\n## 피그마\n${threadHistory}`;
      await _startCodeWork(enrichedWithFigma, figmaPending.say, figmaPending, figmaPending.selectedTickets);
    } else if (reaction === "x") {
      pendingFigmaSelections.delete(msgTs);
      console.log("[FIGMA] 피그마 없이 진행");
      await _startCodeWork(figmaPending.enrichedMessage, figmaPending.say, figmaPending, figmaPending.selectedTickets);
    }
    return;
  }

  const pending = pendingTicketSelections.get(msgTs);
  if (!pending) return;

  // 이모지 → 인덱스 매핑 (pending에 저장된 reactionNames 기반)
  const reactionNames = pending.reactionNames || [];
  const idx = reactionNames.indexOf(reaction);

  if (idx !== -1) {
    if (pending.type === "transition") {
      // /done: transition 선택 (1개만)
      if (idx < pending.transitions.length) {
        pending.selected.clear();
        pending.selected.add(idx);
        console.log(`[JIRA] 전환 선택: ${pending.transitions[idx].name}`);
      }
    } else {
      // 티켓 선택 (복수 가능)
      if (idx < pending.tickets.length) {
        pending.selected.add(idx);
        console.log(`[JIRA] 티켓 선택: ${pending.tickets[idx].key}`);
      }
    }
    return;
  }

  // ✅ → 확정
  if (reaction === "white_check_mark") {
    const selectedTickets = [...pending.selected]
      .sort()
      .map((i) => pending.tickets[i])
      .filter(Boolean);

    pendingTicketSelections.delete(msgTs);

    if (selectedTickets.length === 0) {
      await say({
        text: MESSAGES.TICKET_NO_SELECTION,
        thread_ts: pending.threadTs,
      });
      return;
    }

    // 타입별 분기: transition (상태 전환) vs 기본 (코드 작업)
    if (pending.type === "transition") {
      // 선택된 transition 확인
      const selectedIdx = [...pending.selected][0];
      if (selectedIdx === undefined || !pending.transitions[selectedIdx]) {
        await say({
          text: MESSAGES.TICKET_NO_STATUS_SELECTION,
          thread_ts: pending.threadTs,
        });
        return;
      }

      const targetStatus = pending.transitions[selectedIdx].name;
      const { transitionTicket } = require("./jira");
      const results = [];
      for (const ticket of selectedTickets) {
        const success = await transitionTicket(ticket.key, targetStatus);
        results.push(`${success ? "✅" : "❌"} ${ticket.key} — ${ticket.summary} → ${targetStatus}`);
      }
      await say({
        text: MESSAGES.TICKET_TRANSITION_RESULT(results),
        thread_ts: pending.threadTs,
      });
      return;
    }

    // 선택된 티켓 정보를 요청에 포함
    const ticketContext = selectedTickets
      .map((t) => `[${t.key}] ${t.summary}\n${t.description}`)
      .join("\n---\n");
    const enrichedMessage = `## JIRA 티켓\n${ticketContext}\n\n## 사용자 요청\n${pending.message}`;

    console.log(`[JIRA] ${selectedTickets.length}개 티켓 확정: ${selectedTickets.map((t) => t.key).join(", ")}`);

    // 스레드에 티켓 정보 저장 (나중에 /done에서 활용)
    // threadBranchMap에 아직 항목이 없을 수 있으므로 없으면 생성
    let threadData = threadBranchMap.get(pending.threadTs);
    if (!threadData) {
      threadData = { branchName: null, hasCommit: false, changes: [] };
      threadBranchMap.set(pending.threadTs, threadData);
    }
    threadData.jiraTickets = selectedTickets.map((t) => t.key);
    saveThreadMap(threadBranchMap);

    // 피그마 링크 확인: 티켓 description + 원본 메시지에서 피그마 링크 검색
    const allText = selectedTickets.map((t) => t.description || "").join(" ") + " " + pending.message;
    const hasFigmaInTicket = containsFigmaLink(allText);

    if (!hasFigmaInTicket && CONFIG.figma.apiKey) {
      // 피그마 링크 없음 → 유저에게 물어보기
      console.log("[FIGMA] 티켓에 피그마 링크 없음, 유저에게 확인 중...");
      const figmaMsg = await slackClient.chat.postMessage({
        channel: pending.channel,
        thread_ts: pending.threadTs,
        text: MESSAGES.FIGMA_ASK,
      });

      await addReaction(pending.channel, figmaMsg.ts, "white_check_mark");
      await addReaction(pending.channel, figmaMsg.ts, "x");

      pendingFigmaSelections.set(figmaMsg.ts, {
        enrichedMessage,
        say,
        threadTs: pending.threadTs,
        userName: pending.userName,
        channel: pending.channel,
        threadHistory: pending.threadHistory,
        selectedTickets,
      });
      return;
    }

    // 피그마 링크 있거나 피그마 비활성화 → 바로 진행
    await _startCodeWork(enrichedMessage, say, pending, selectedTickets);
  }
}

/** 피그마 선택 후 또는 바로 코드 작업 시작 */
async function _startCodeWork(enrichedMessage, say, opts, selectedTickets) {
  await say({
    text: MESSAGES.TICKET_START(selectedTickets.map((t) => t.key)),
    thread_ts: opts.threadTs,
  });

  const queuePosition = getQueueLength();
  if (queuePosition > 0) {
    await say({ text: MESSAGES.QUEUE(queuePosition), thread_ts: opts.threadTs });
  }
  return enqueueRequest(() =>
    _processCodeRequest(
      enrichedMessage,
      say,
      opts.threadTs,
      opts.userName,
      opts.channel,
      opts.threadHistory,
      selectedTickets,
    ),
  );
}

/**
 * /done 명령 처리 — 티켓 상태 전환 확인
 */
async function processDoneRequest(say, threadTs, channel) {
  const threadData = threadBranchMap.get(threadTs);
  const ticketKeys = threadData?.jiraTickets || [];

  if (ticketKeys.length === 0) {
    await say({
      text: MESSAGES.TICKET_NO_LINK,
      thread_ts: threadTs,
    });
    return;
  }

  // 현재 티켓 상태 조회
  const { fetchTicket } = require("./jira");
  const tickets = [];
  for (const key of ticketKeys) {
    const ticket = await fetchTicket(key);
    if (ticket) tickets.push(ticket);
  }

  if (tickets.length === 0) {
    await say({
      text: MESSAGES.TICKET_FETCH_ERROR,
      thread_ts: threadTs,
    });
    return;
  }

  // 가능한 전환 상태 조회 (첫 번째 티켓 기준)
  const https = require("https");
  const { CONFIG: cfg } = require("./config");
  const auth = Buffer.from(`${cfg.jira.email}:${cfg.jira.apiToken}`).toString("base64");
  let transitions = [];
  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get({
        hostname: cfg.jira.host,
        path: `/rest/api/3/issue/${ticketKeys[0]}/transitions`,
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      });
      req.on("error", reject);
    });
    transitions = data.transitions || [];
  } catch (err) {
    console.error("[JIRA] 전환 목록 조회 실패:", err.message);
  }

  if (transitions.length === 0) {
    await say({
      text: MESSAGES.TICKET_NO_TRANSITION,
      thread_ts: threadTs,
    });
    return;
  }

  const DISPLAY_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
  const REACTION_NAMES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

  const transitionCount = Math.min(transitions.length, 9);

  const ticketList = tickets
    .map((t) => `• ${t.key} — ${t.summary} (현재: ${t.status})`)
    .join("\n");

  const transitionLines = transitions.slice(0, transitionCount).map((t, i) =>
    `${DISPLAY_EMOJIS[i]}  ${t.name}`,
  );

  const msg = [
    "🎫 티켓 상태를 변경할게요!",
    "",
    "*대상 티켓:*",
    ticketList,
    "",
    "*어떤 상태로 바꿀까요?*",
    ...transitionLines,
    "",
    "번호 이모지를 누른 뒤 ✅ 를 눌러주세요!",
  ].join("\n");

  const msgResult = await slackClient.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: msg,
  });

  for (let i = 0; i < transitionCount; i++) {
    await addReaction(channel, msgResult.ts, REACTION_NAMES[i]);
  }
  await addReaction(channel, msgResult.ts, "white_check_mark");

  pendingTicketSelections.set(msgResult.ts, {
    type: "transition",
    tickets,
    transitions: transitions.slice(0, transitionCount),
    reactionNames: REACTION_NAMES.slice(0, transitionCount),
    selected: new Set(),
    threadTs,
    channel,
  });
}

module.exports = { processRequest, processPrRequest, handleReaction, pendingTicketSelections, processDoneRequest };
