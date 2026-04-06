// ============================================
// 웹 API용 핸들러 — 슬랙/JIRA 의존성 없이 순수 파이프라인
// ============================================
const { CONFIG } = require("./config");
const { run, ensureRepo, ensureDocsRepo, switchToBranch } = require("./git");
const { WIZKEY_SYSTEM_PROMPT, TALK_SYSTEM_PROMPT, ASK_SYSTEM_PROMPT } = require("../wizkey-prompt");
const { threadBranchMap, saveThreadMap } = require("./thread-map");
const { enqueueRequest, getQueueLength } = require("./queue");
const { createBranchName, containsFigmaLink } = require("./parser");
const { waitForVercelDeployment } = require("./vercel");
const { classifyMessage, summarizeChanges, verifyChanges } = require("./classifier");
const { collectFileTree, identifyRelevantFiles, readFiles, validateFileSelection } = require("./file-analyzer");
const { fetchFigmaData } = require("./figma");
const { generateCodeChanges, fixBuildError } = require("./code-generator");
const { applyChanges, runBuild, revertChanges } = require("./builder");
const { buildDocsContext } = require("./docs-reader");
const { callHaiku, callHaikuStream } = require("./claude");
const { findOrCreateConversation, saveMessage, updateConversation } = require("./database");

/**
 * 메시지 처리 — 분류 후 분기
 * @param {object} params
 * @param {string} params.message - 사용자 메시지
 * @param {string} [params.threadId] - 스레드 ID (후속 요청 시)
 * @param {string} [params.figmaUrl] - 피그마 URL
 * @param {string} [params.userName] - 사용자 이름
 * @param {string[]} [params.chatHistory] - 이전 대화 히스토리
 * @param {function} emit - 실시간 이벤트 전송 (type, data)
 * @returns {object} 응답 결과
 */
async function handleRequest({ message, threadId, figmaUrl, userName, chatHistory, deviceId, images }, emit) {
  const threadHistory = chatHistory ? chatHistory.join("\n") : null;

  // DB: 대화 찾기/생성 + 유저 메시지 저장
  const effectiveDeviceId = deviceId || "anonymous";
  const conversation = findOrCreateConversation(effectiveDeviceId, threadId);
  saveMessage({ conversationId: conversation.id, role: "user", content: message, type: null, metadata: { figmaUrl, userName } });

  // 분류
  emit("status", { step: "classify", state: "start" });
  const category = await classifyMessage(message, threadHistory);
  console.log(`[CLASSIFIER] 결과: ${category}`);
  emit("status", { step: "classify", state: "done", result: category });

  if (category === "talk") {
    const result = await _handleTalk(message, userName, threadHistory, emit);
    saveMessage({ conversationId: conversation.id, role: "assistant", content: result.message, type: "talk" });
    if (!conversation.title) updateConversation(conversation.id, { title: message.slice(0, 100) });
    return { ...result, threadId: conversation.thread_id };
  }

  if (category === "ask") {
    const result = await _handleAsk(message, userName, threadHistory, threadId, emit);
    saveMessage({ conversationId: conversation.id, role: "assistant", content: result.message, type: "ask" });
    if (!conversation.title) updateConversation(conversation.id, { title: message.slice(0, 100) });
    return { ...result, threadId: conversation.thread_id };
  }

  if (category === "unclear") {
    const msg = "요청을 이해하지 못했어요. 좀 더 구체적으로 말씀해주세요.";
    saveMessage({ conversationId: conversation.id, role: "assistant", content: msg, type: "unclear" });
    return { type: "unclear", message: msg, threadId: conversation.thread_id };
  }

  // code 요청 — 이해 확인 메시지 생성
  const fullMessage = figmaUrl ? `${message}\n\n피그마: ${figmaUrl}` : message;

  try {
    const ack = await callHaikuStream(
      `너는 UI 수정 에이전트야. 사용자의 요청을 읽고, 이해한 내용을 1~2문장으로 자연스럽게 확인해줘.
"네, ~하겠습니다" 형태로 시작해. 요청에 포함된 핵심 변경사항을 간결히 언급해.
구체적 구현 방법은 말하지 마. 예시: "네, 버튼 호버 시 물결 효과를 추가하고 트랜지션을 부드럽게 적용하겠습니다."`,
      message,
      (chunk) => emit("stream", { delta: chunk }),
    );
    emit("stream_end", { content: ack });
  } catch {
    // 실패해도 작업은 계속 진행
  }

  if (!conversation.title) updateConversation(conversation.id, { title: message.slice(0, 100) });

  const queuePosition = getQueueLength();
  if (queuePosition > 0) {
    emit("status", { step: "queue", position: queuePosition });
  }

  return new Promise((resolve, reject) => {
    enqueueRequest(async () => {
      try {
        const result = await _processCodeRequest({
          message: fullMessage,
          threadId: conversation.thread_id,
          userName,
          threadHistory,
          emit,
          conversationId: conversation.id,
          images,
        });
        resolve(result);
      } catch (err) {
        saveMessage({ conversationId: conversation.id, role: "assistant", content: err.message, type: "error" });
        reject(err);
      }
    });
  });
}

/** talk 처리 */
async function _handleTalk(message, userName, threadHistory, emit) {
  let prompt = message;
  if (threadHistory) prompt = `## 이전 대화\n${threadHistory}\n\n## 현재 메시지\n${prompt}`;
  if (userName) prompt = `사용자 이름: ${userName}\n\n${prompt}`;
  const answer = await callHaikuStream(TALK_SYSTEM_PROMPT, prompt, (chunk) => {
    emit("stream", { delta: chunk });
  });
  return { type: "talk", message: answer };
}

/** ask 처리 */
async function _handleAsk(message, userName, threadHistory, threadId, emit) {
  await ensureRepo();

  // 기존 브랜치가 있으면 해당 브랜치에서 코드 읽기
  const threadData = threadBranchMap.get(threadId);
  if (threadData?.branchName) {
    await switchToBranch(threadData.branchName).catch(() => {});
  }

  const repoPath = CONFIG.repo.path;
  const fileTree = collectFileTree(repoPath);
  const relevantPaths = await identifyRelevantFiles(message, fileTree, null);
  const fileContents = readFiles(relevantPaths, repoPath);

  let prompt = message;
  if (fileContents.length > 0) {
    const filesContext = fileContents
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join("\n\n");
    prompt = `## 질문\n${message}\n\n## 참고 파일\n${filesContext}`;
  }
  if (threadHistory) prompt = `## 이전 대화\n${threadHistory}\n\n${prompt}`;
  if (userName) prompt = `사용자 이름: ${userName}\n\n${prompt}`;

  const answer = await callHaikuStream(ASK_SYSTEM_PROMPT, prompt, (chunk) => {
    emit("stream", { delta: chunk });
  });
  await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
  return { type: "ask", message: answer };
}

/**
 * 코드 수정 파이프라인 — 슬랙 의존성 제거, emit으로 진행상황 전달
 */
async function _processCodeRequest({ message, threadId, userName, threadHistory, emit, conversationId, images }) {
  const existing = threadBranchMap.get(threadId);
  const isFollowUp = !!existing;
  let branchName;
  const repoPath = CONFIG.repo.path;

  // 1. 브랜치 준비
  emit("progress", { step: "branch", state: "start" });
  await ensureRepo();

  if (isFollowUp) {
    branchName = existing.branchName;
    try {
      await switchToBranch(branchName);
    } catch {
      branchName = await createBranchName(message);
      await switchToBranch(branchName, true);
      threadBranchMap.set(threadId, { branchName, hasCommit: false, changes: [] });
      saveThreadMap(threadBranchMap);
    }
  } else {
    branchName = await createBranchName(message);
    await switchToBranch(branchName, true);
    threadBranchMap.set(threadId, { branchName, hasCommit: false, changes: [] });
    saveThreadMap(threadBranchMap);
  }
  emit("progress", { step: "branch", state: "done", branchName });

  // 2. 피그마 데이터
  let figmaData = null;
  const hasFigma = containsFigmaLink(message);
  if (hasFigma && CONFIG.figma.apiKey) {
    emit("progress", { step: "figma", state: "start" });
    try {
      figmaData = await fetchFigmaData(message);
      emit("progress", { step: "figma", state: "done", count: figmaData?.specs?.length || 0 });
    } catch (err) {
      emit("progress", { step: "figma", state: "error", error: err.message });
    }
  }

  // 2-b. 이미지 분석
  if (images && images.length > 0) {
    emit("progress", { step: "image", state: "start", count: images.length });
    emit("progress", { step: "image", state: "done", count: images.length });
  }

  // 3. 파일 분석 + 선정 검증
  emit("progress", { step: "analyze", state: "start" });
  const fileTree = collectFileTree(repoPath);
  const initialPaths = await identifyRelevantFiles(message, fileTree, figmaData);
  const relevantPaths = validateFileSelection(message, initialPaths, fileTree);
  const fileContents = readFiles(relevantPaths, repoPath);
  emit("progress", { step: "analyze", state: "done", fileCount: fileContents.length });

  // 4. docs 스펙 분석
  let docsResult = null;
  if (CONFIG.docs.url) {
    emit("progress", { step: "docs", state: "start" });
    try {
      const docsReady = await ensureDocsRepo();
      if (docsReady) {
        docsResult = await buildDocsContext(message, fileContents);
        if (docsResult?.implStatus?.status === "implemented") {
          emit("progress", { step: "docs", state: "done", status: "implemented" });
          await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
          const implResult = {
            type: "already_implemented",
            specIds: docsResult.specIds,
            implemented: docsResult.implStatus.implemented,
          };
          saveMessage({ conversationId, role: "assistant", content: `이미 구현됨: ${docsResult.implStatus.implemented?.join(", ")}`, type: "already_implemented", metadata: implResult });
          return implResult;
        }
        emit("progress", { step: "docs", state: "done", status: docsResult?.implStatus?.status || "none" });
      }
    } catch (err) {
      emit("progress", { step: "docs", state: "error", error: err.message });
    }
  }

  // 5. 코드 생성 (멀티턴 중 즉시 디스크 적용됨)
  emit("progress", { step: "codegen", state: "start" });
  const threadData = threadBranchMap.get(threadId);
  const context = {
    isFollowUp,
    isFirstCommit: !threadData.hasCommit,
    previousChanges: isFollowUp ? threadData.changes.join("\n---\n") : null,
    threadHistory,
    docsContext: docsResult?.docsContext || null,
    images,
  };

  let codeResult;
  try {
    codeResult = await generateCodeChanges(message, fileContents, figmaData, context, repoPath);
  } catch (err) {
    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
    throw new Error(`코드 생성 실패: ${err.message}`);
  }

  let appliedChanges = codeResult.appliedChanges || [];

  if (appliedChanges.length === 0) {
    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
    saveMessage({ conversationId, role: "assistant", content: "수정할 내용을 찾지 못했어요.", type: "no_changes" });
    return { type: "no_changes", message: "수정할 내용을 찾지 못했어요." };
  }

  emit("progress", { step: "codegen", state: "done", fileCount: [...new Set(appliedChanges.map((c) => c.filePath))].length });

  // 6. 빌드 (검증보다 먼저)
  // 8. 빌드
  emit("progress", { step: "build", state: "start" });
  let buildResult;
  for (let attempt = 1; attempt <= 3; attempt++) {
    buildResult = await runBuild(repoPath);
    if (buildResult.success) break;

    if (attempt < 3) {
      const allPaths = [...new Set([...relevantPaths, ...appliedChanges.map((c) => c.filePath)])];
      const currentFiles = readFiles(allPaths, repoPath);
      try {
        const fixResult = await fixBuildError(buildResult.stderr, currentFiles, repoPath);
        appliedChanges.push(...(fixResult.appliedChanges || []));
      } catch {}
    }
  }

  if (!buildResult.success) {
    await revertChanges(repoPath);
    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
    emit("progress", { step: "build", state: "error" });

    // 에러 요약 생성
    let errorSummary;
    try {
      errorSummary = await callHaiku(
        `너는 프론트엔드 빌드 에러 분석기야. 아래 빌드 에러를 비개발자도 이해할 수 있게 1~2문장으로 요약해.
"빌드에 실패했어요." 로 시작해. 어떤 파일에서 무슨 문제가 있는지 간결하게 설명해.
기술적 용어는 최소화하고, 해결 방향을 간단히 제시해.`,
        buildResult.stderr.slice(0, 1000),
      );
    } catch {
      errorSummary = "빌드에 실패했어요. 코드에 오류가 있어 수정이 필요해요.";
    }

    saveMessage({ conversationId, role: "assistant", content: errorSummary, type: "build_failed", metadata: { rawError: buildResult.stderr.slice(0, 500) } });
    return { type: "build_failed", errorSummary, error: buildResult.stderr.slice(0, 500) };
  }
  emit("progress", { step: "build", state: "done" });

  // 7. 검증 (빌드 성공 후 — 실제 디스크 상태 기반)
  for (let v = 1; v <= 2; v++) {
    const verification = await verifyChanges(message, appliedChanges, repoPath);
    if (verification.passed) break;
    if (v >= 2) break;

    console.log(`[VERIFY] 누락 감지, 보완 시도 (${v}/2): ${verification.missing}`);
    const allPaths = [...new Set([...relevantPaths, ...appliedChanges.map((c) => c.filePath)])];
    const currentFiles = readFiles(allPaths, repoPath);
    try {
      const supplementResult = await generateCodeChanges(
        `원래 요청: ${message}\n\n누락된 작업: ${verification.missing}\n\n누락된 부분만 추가로 구현해줘.`,
        currentFiles, figmaData, context, repoPath,
      );
      appliedChanges.push(...(supplementResult.appliedChanges || []));

      // 보완 후 빌드 재확인
      const rebuildResult = await runBuild(repoPath);
      if (!rebuildResult.success) {
        console.warn("[VERIFY] 보완 후 빌드 실패 — 보완 건너뜀");
        await revertChanges(repoPath);
        // 보완 전 상태로 복원 (원본 변경만 다시 적용)
        break;
      }
    } catch {}
  }

  // 9. git push
  emit("progress", { step: "push", state: "start" });
  const changedFiles = [...new Set(appliedChanges.map((c) => c.filePath))];
  try {
    await run(`git add ${changedFiles.map((f) => `"${f}"`).join(" ")}`, repoPath);
  } catch {
    await run("git add -A", repoPath);
  }

  let commitMsg;
  try {
    commitMsg = await callHaiku(
      `너는 git 커밋 메시지 생성기야. design: 접두사로 시작하는 한국어 커밋 메시지를 한 줄로 작성해. 50자 이내. 커밋 메시지만 출력해.`,
      `요청: ${message}\n수정된 파일: ${changedFiles.join(", ")}`,
    );
    commitMsg = commitMsg.trim().replace(/"/g, '\\"');
  } catch {
    commitMsg = `design: ${message.slice(0, 50).replace(/"/g, '\\"')}`;
  }
  await run(`git commit -m "${commitMsg}"`, repoPath);
  await run(`git push origin ${branchName}`, repoPath);
  const pushTimestamp = Date.now();
  emit("progress", { step: "push", state: "done" });

  // 10. 스레드 데이터 업데이트
  threadData.hasCommit = true;
  threadData.changes.push(
    appliedChanges.map((c) => `${c.type}: ${c.filePath}`).join("\n").slice(0, 500),
  );
  saveThreadMap(threadBranchMap);

  // 11. Vercel 배포 대기
  emit("progress", { step: "deploy", state: "start" });
  const previewUrl = await waitForVercelDeployment(branchName, pushTimestamp);
  emit("progress", { step: "deploy", state: "done", previewUrl });

  // 12. 변경 요약
  const changeSummary = appliedChanges
    .map((c) => {
      if (c.type === "create") return `생성: ${c.filePath}\n미리보기: ${(c.content || "").slice(0, 200)}`;
      return `수정: ${c.filePath}\n이전: ${(c.oldString || "").slice(0, 100)}\n이후: ${(c.newString || "").slice(0, 100)}`;
    })
    .join("\n---\n");
  const summary = await summarizeChanges(`## 원래 요청\n${message}\n\n## 변경 내역\n${changeSummary}`) || changeSummary;

  await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});

  // DB: 성공 결과 저장 + 대화 메타데이터 업데이트
  const resultData = { type: "success", summary, branchName, previewUrl, changedFiles, threadId };
  saveMessage({ conversationId, role: "assistant", content: summary, type: "success", metadata: { branchName, previewUrl, changedFiles } });
  updateConversation(conversationId, { branch_name: branchName });

  return resultData;
}

/**
 * PR 생성 — 브랜치 이름으로 PR 생성
 */
async function createPullRequest(branchName) {
  const fs = require("fs");
  const path = require("path");

  await ensureRepo();
  await switchToBranch(branchName);

  // git log로 커밋 이력
  const gitLog = await run(
    `git log ${CONFIG.repo.branch}..HEAD --pretty=format:"%s"`,
    CONFIG.repo.path,
  );

  // threadMap에서 변경 내역 찾기
  let changesSummary = "";
  for (const [, data] of threadBranchMap) {
    if (data.branchName === branchName) {
      changesSummary = data.changes?.join("\n") || "";
      break;
    }
  }

  // Haiku로 PR 제목 + 본문 생성
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
      `브랜치: ${branchName}\n커밋 이력:\n${gitLog}\n\n변경 파일:\n${changesSummary}`,
    );
    const titleMatch = prContent.match(/TITLE:\s*(.+)/);
    const bodyMatch = prContent.match(/BODY:\s*([\s\S]+)/);
    prTitle = titleMatch ? titleMatch[1].trim() : `design: ${branchName.replace("design/", "")}`;
    prBody = bodyMatch ? bodyMatch[1].trim() : changesSummary;
  } catch {
    prTitle = `design: ${branchName.replace("design/", "")}`;
    prBody = changesSummary || "디자인 수정";
  }

  // PR 생성
  const prBodyPath = path.join("/tmp", "design-bot-pr-body.tmp");
  fs.writeFileSync(prBodyPath, prBody, "utf-8");
  const safeTitle = prTitle.replace(/"/g, '\\"').replace(/`/g, "\\`");

  let prUrl;
  try {
    const existingPr = await run(
      `gh pr view ${branchName} --json url --jq .url`,
      CONFIG.repo.path,
    );
    if (existingPr && existingPr.includes("github.com")) {
      prUrl = existingPr.trim();
    }
  } catch {}

  if (!prUrl) {
    const prOutput = await run(
      `gh pr create --title "${safeTitle}" --body-file ${prBodyPath} --base ${CONFIG.repo.branch} --draft`,
      CONFIG.repo.path,
    );
    const prUrlMatch = prOutput.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    prUrl = prUrlMatch ? prUrlMatch[0] : null;
  }

  try { fs.unlinkSync(prBodyPath); } catch {}
  await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});

  return { prUrl, prTitle, branchName };
}

module.exports = { handleRequest, createPullRequest };
