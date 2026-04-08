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
const { findOrCreateConversation, saveMessage, updateConversation, updateProcessingStatus, getConversationMessages } = require("./database");

// 대화별 이미지 캐시 — 같은 대화에서 후속 메시지가 이전 이미지를 참조할 수 있도록
const conversationImageCache = new Map(); // conversationId → images[]

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
async function handleRequest(params, emit) {
  let _convId = null;
  try {
    return await _handleRequestInner(params, emit, (id) => { _convId = id; });
  } finally {
    // 어떤 경로든 처리 완료 시 processing 해제
    if (_convId) await updateProcessingStatus(_convId, null);
  }
}

async function _handleRequestInner({ message, threadId, figmaUrl, userName, chatHistory, userId, images }, emit, setConvId) {
  // 빈 메시지 보정
  message = message || "";

  // DB: 대화 찾기/생성 + 유저 메시지 저장
  const conversation = await findOrCreateConversation(userId, threadId);

  // 대화 히스토리 — DB에서 직접 읽어서 메타데이터(브랜치, 파일 등)까지 포함
  const dbMessages = await getConversationMessages(conversation.id);
  let threadHistory = null;
  if (dbMessages.length > 0) {
    threadHistory = dbMessages.map((m) => {
      const role = m.role === "user" ? "사용자" : "봇";
      let line = `${role}: ${m.content}`;
      // 봇의 수정 결과 메타데이터 포함
      if (m.role === "assistant" && m.metadata) {
        if (m.metadata.branchName) line += `\n[브랜치: ${m.metadata.branchName}]`;
        if (m.metadata.changedFiles?.length) line += `\n[수정 파일: ${m.metadata.changedFiles.join(", ")}]`;
        if (m.metadata.previewUrl) line += `\n[프리뷰: ${m.metadata.previewUrl}]`;
      }
      return line;
    }).join("\n\n");
  }
  setConvId(conversation.id);
  await saveMessage({ conversationId: conversation.id, role: "user", content: message || "", type: null, metadata: { figmaUrl, userName, hasImages: !!(images && images.length > 0), imageCount: images?.length || 0 } });

  // 처리 상태 추적 — DB에 저장해서 새로고침 후에도 복원 가능
  const processingSteps = [];
  const _originalEmit = emit;
  emit = (type, data) => {
    _originalEmit(type, data);
    if ((type === "progress" || type === "status") && data?.step) {
      const existing = processingSteps.find((s) => s.step === data.step);
      if (existing) Object.assign(existing, data);
      else processingSteps.push({ ...data });
      updateProcessingStatus(conversation.id, { processing: true, steps: processingSteps }).catch(() => {});
    }
  };
  // 시작 표시
  await updateProcessingStatus(conversation.id, { processing: true, steps: [] });

  // 이미지 캐시 — 새 이미지가 오면 저장, 없으면 이전 이미지 사용
  if (images && images.length > 0) {
    conversationImageCache.set(conversation.id, images);
    console.log(`[IMG] 이미지 캐시 저장: conv:${conversation.id.slice(0, 8)} → ${images.length}장`);
  }
  const cachedImages = conversationImageCache.get(conversation.id) || null;

  // 분류
  emit("status", { step: "classify", state: "start" });
  const hasImages = (images && images.length > 0);
  const hasCachedImages = !!cachedImages;
  const hasText = message && message.trim().length > 0;
  let category;
  if (hasImages && hasText) {
    // 이미지 + 텍스트 → 텍스트 기반 분류 (대부분 code)
    category = await classifyMessage(message, threadHistory);
  } else if (hasImages && !hasText) {
    // 이미지만 → 뭘 해달라는 건지 되물어보기
    category = "unclear";
  } else {
    category = await classifyMessage(message, threadHistory);
  }
  console.log(`[CLASSIFIER] 결과: ${category}`);
  emit("status", { step: "classify", state: "done", result: category });

  // 현재 요청의 이미지 또는 캐시된 이미지
  const effectiveImages = hasImages ? images : cachedImages;

  if (category === "talk") {
    const result = await _handleTalk(message, userName, threadHistory, emit, effectiveImages);
    await saveMessage({ conversationId: conversation.id, role: "assistant", content: result.message, type: "talk" });
    if (!conversation.title) await updateConversation(conversation.id, { title: message.slice(0, 100) });
    return { ...result, threadId: conversation.thread_id };
  }

  if (category === "ask") {
    const result = await _handleAsk(message, userName, threadHistory, threadId, emit, effectiveImages);
    await saveMessage({ conversationId: conversation.id, role: "assistant", content: result.message, type: "ask" });
    if (!conversation.title) await updateConversation(conversation.id, { title: message.slice(0, 100) });
    return { ...result, threadId: conversation.thread_id };
  }

  if (category === "unclear") {
    const msg = hasImages
      ? "이미지를 확인했어요! 어떻게 도와드릴까요?\n\n예시:\n• \"이 디자인대로 구현해줘\"\n• \"이 부분의 색상을 바꿔줘\"\n• \"이 레이아웃을 참고해서 수정해줘\""
      : "요청을 이해하지 못했어요. 좀 더 구체적으로 말씀해주세요.";
    await saveMessage({ conversationId: conversation.id, role: "assistant", content: msg, type: "unclear" });
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

  if (!conversation.title) await updateConversation(conversation.id, { title: message.slice(0, 100) });

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
          images: effectiveImages,
        });
        resolve(result);
      } catch (err) {
        await saveMessage({ conversationId: conversation.id, role: "assistant", content: err.message, type: "error" });
        reject(err);
      }
    });
  });
}

/** 이미지가 있으면 multimodal content 배열, 없으면 텍스트 */
function buildMessageContent(textPrompt, images) {
  if (!images || images.length === 0) return textPrompt;
  const content = [];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  }
  content.push({ type: "text", text: textPrompt });
  return content;
}

/** talk 처리 */
async function _handleTalk(message, userName, threadHistory, emit, images) {
  let prompt = message;
  if (threadHistory) prompt = `## 이전 대화\n${threadHistory}\n\n## 현재 메시지\n${prompt}`;
  if (userName) prompt = `사용자 이름: ${userName}\n\n${prompt}`;
  const answer = await callHaikuStream(TALK_SYSTEM_PROMPT, buildMessageContent(prompt, images), (chunk) => {
    emit("stream", { delta: chunk });
  });
  return { type: "talk", message: answer };
}

/** ask 처리 */
async function _handleAsk(message, userName, threadHistory, threadId, emit, images) {
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

  const answer = await callHaikuStream(ASK_SYSTEM_PROMPT, buildMessageContent(prompt, images), (chunk) => {
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
          await saveMessage({ conversationId, role: "assistant", content: `이미 구현됨: ${docsResult.implStatus.implemented?.join(", ")}`, type: "already_implemented", metadata: implResult });
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

  // 코드베이스 컨텍스트 — tailwind config, 기존 컴포넌트 목록
  let codebaseContext = "";
  try {
    const fs = require("fs");
    const path = require("path");
    // tailwind config
    for (const configName of ["tailwind.config.ts", "tailwind.config.js"]) {
      const configPath = path.join(repoPath, configName);
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, "utf-8");
        codebaseContext += `### ${configName} (커스텀 색상/토큰 참고)\n\`\`\`\n${configContent.slice(0, 3000)}\n\`\`\`\n\n`;
        break;
      }
    }
    // 기존 컴포넌트 목록
    const componentsDir = path.join(repoPath, "src/components");
    if (fs.existsSync(componentsDir)) {
      const components = fs.readdirSync(componentsDir, { recursive: true })
        .filter((f) => f.endsWith("index.tsx"))
        .map((f) => `src/components/${f}`);
      if (components.length > 0) {
        codebaseContext += `### 기존 컴포넌트 (재사용 가능)\n${components.join("\n")}\n\n`;
      }
    }
  } catch {}

  const context = {
    isFollowUp,
    isFirstCommit: !threadData.hasCommit,
    previousChanges: isFollowUp ? threadData.changes.join("\n---\n") : null,
    threadHistory,
    docsContext: docsResult?.docsContext || null,
    images,
    codebaseContext: codebaseContext || null,
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
    await saveMessage({ conversationId, role: "assistant", content: "수정할 내용을 찾지 못했어요.", type: "no_changes" });
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

    await saveMessage({ conversationId, role: "assistant", content: errorSummary, type: "build_failed", metadata: { rawError: buildResult.stderr.slice(0, 500) } });
    return { type: "build_failed", errorSummary, error: buildResult.stderr.slice(0, 500) };
  }
  emit("progress", { step: "build", state: "done" });

  // 빌드 성공 시점을 임시 커밋으로 저장 — 보완 실패 시 여기로 복원
  await run("git add -A", repoPath);
  await run('git commit -m "__checkpoint: build passed"', repoPath).catch(() => {});

  // 7. 검증 (빌드 성공 후 — 실제 디스크 상태 기반)
  const appliedBeforeVerify = [...appliedChanges];
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
        console.warn("[VERIFY] 보완 후 빌드 실패 — 체크포인트로 복원");
        // 보완분만 되돌리기 — 체크포인트 커밋으로 리셋
        await run("git reset --hard HEAD", repoPath);
        appliedChanges.length = 0;
        appliedChanges.push(...appliedBeforeVerify);
        break;
      }
    } catch {
      // 보완 생성 자체 실패 — 원본 유지
      await run("git reset --hard HEAD", repoPath).catch(() => {});
      appliedChanges.length = 0;
      appliedChanges.push(...appliedBeforeVerify);
      break;
    }
  }

  // 체크포인트 커밋을 언커밋 (변경사항은 유지, 커밋만 제거 — 나중에 진짜 커밋으로 교체)
  await run("git reset --soft HEAD~1", repoPath).catch(() => {});

  // 9. git push
  emit("progress", { step: "push", state: "start" });
  const changedFiles = [...new Set(appliedChanges.map((c) => c.filePath))];

  // 변경사항 없으면 커밋 스킵
  const gitStatus = await run("git status --porcelain", repoPath).catch(() => "");
  if (!gitStatus.trim()) {
    console.warn("[GIT] 변경사항 없음 — 커밋 스킵");
    emit("progress", { step: "push", state: "done" });
    await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
    await saveMessage({ conversationId, role: "assistant", content: "코드를 수정했지만 최종 반영할 변경사항이 없었어요.", type: "no_changes" });
    return { type: "no_changes", message: "코드를 수정했지만 최종 반영할 변경사항이 없었어요.", threadId };
  }

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
  await saveMessage({ conversationId, role: "assistant", content: summary, type: "success", metadata: { branchName, previewUrl, changedFiles } });
  await updateConversation(conversationId, { branch_name: branchName });

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
