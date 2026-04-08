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

// AI 재시도 루프 안전장치: 최대 반복 횟수
const MAX_LOOP = 10;

// ============================================
// 작업 플래닝 — Haiku가 실행 계획 + 안내 메시지 생성
// ============================================
const PLAN_SYSTEM = `너는 코드 수정 에이전트의 작업 플래너야.
사용자의 요청과 주어진 조건을 분석해서, 어떤 단계를 어떤 순서로 실행할지 계획을 세워.

## 사용 가능한 단계
- analyze_image: 사용자가 보낸 이미지/스크린샷을 분석해서 디자인 의도 파악
- fetch_figma: 피그마 URL에서 디자인 스펙 데이터 가져오기
- analyze_files: 프로젝트 파일 구조를 분석해서 수정할 파일 찾기
- check_docs: 스펙 문서 레포에서 관련 기획 내용 확인
- generate_code: AI가 코드 수정안을 생성하고 적용
- build: 빌드(컴파일) 검증 — 실패 시 AI가 자동 수정 후 재시도
- verify: AI가 수정 결과를 검증 — 누락된 부분 있으면 보완
- push: git 커밋 & 푸시
- deploy: Vercel 프리뷰 배포 대기

## 규칙
- hasImages가 false면 analyze_image를 절대 넣지 마
- hasFigma가 false면 fetch_figma를 절대 넣지 마
- hasDocs가 false면 check_docs를 절대 넣지 마
- analyze_files, generate_code, build, verify, push, deploy는 항상 포함
- 순서: analyze_image/fetch_figma → analyze_files → check_docs → generate_code → build → verify → push → deploy
- message에 유저한테 보여줄 자연스러운 안내를 1~2문장으로 작성해. 뭘 할 건지 미리 알려주는 톤.
  - 이미지가 있으면 이미지 분석한다고 언급해
  - 피그마가 있으면 디자인 스펙 참고한다고 언급해
  - 후속 요청(isFollowUp)이면 이전 작업에 이어서 한다고 언급해

## 응답 형식 (JSON만 출력)
{
  "steps": ["analyze_files", "generate_code", "build", "verify", "push", "deploy"],
  "message": "코드를 분석해서 수정하고, 빌드 검증 후 프리뷰를 보여드릴게요!"
}`;

async function _planSteps({ message, hasImages, hasFigma, hasDocs, isFollowUp }) {
  try {
    const input = JSON.stringify({ message: message.slice(0, 300), hasImages, hasFigma, hasDocs, isFollowUp });
    const raw = await callHaiku(PLAN_SYSTEM, input);
    const plan = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);

    // 안전장치: 필수 단계 누락 방지
    const required = ["analyze_files", "generate_code", "build", "verify", "push", "deploy"];
    for (const step of required) {
      if (!plan.steps.includes(step)) plan.steps.push(step);
    }
    // 조건부 단계가 잘못 들어간 경우 제거
    if (!hasImages) plan.steps = plan.steps.filter((s) => s !== "analyze_image");
    if (!hasFigma) plan.steps = plan.steps.filter((s) => s !== "fetch_figma");
    if (!hasDocs) plan.steps = plan.steps.filter((s) => s !== "check_docs");

    return plan;
  } catch (err) {
    console.warn("[PLAN] 플래닝 실패, 기본 계획 사용:", err.message);
    // 폴백: 기본 계획
    const steps = [];
    if (hasImages) steps.push("analyze_image");
    if (hasFigma) steps.push("fetch_figma");
    steps.push("analyze_files");
    if (hasDocs) steps.push("check_docs");
    steps.push("generate_code", "build", "verify", "push", "deploy");
    return { steps, message: "코드를 수정하고 프리뷰를 준비할게요!" };
  }
}

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

  // code 요청 — plan 메시지는 _processCodeRequest 안에서 emit
  const fullMessage = figmaUrl ? `${message}\n\n피그마: ${figmaUrl}` : message;

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
 * 코드 수정 파이프라인 — Haiku 플래닝 → stepHandlers 순차 실행
 */
async function _processCodeRequest({ message, threadId, userName, threadHistory, emit, conversationId, images }) {
  const existing = threadBranchMap.get(threadId);
  const isFollowUp = !!existing;
  const repoPath = CONFIG.repo.path;
  const hasFigma = containsFigmaLink(message);

  // 공유 컨텍스트 — stepHandlers 간 데이터 전달용
  const ctx = {
    message, threadId, userName, threadHistory, emit, conversationId, images,
    repoPath, isFollowUp, existing,
    branchName: null,
    figmaData: null,
    fileContents: [],
    relevantPaths: [],
    docsResult: null,
    appliedChanges: [],
    context: null, // 코드 생성에 넘길 context
    pushTimestamp: null,
  };

  // ── 0. 브랜치 준비 (항상 실행, 플랜 밖) ──
  await ensureRepo();
  if (isFollowUp) {
    ctx.branchName = existing.branchName;
    try {
      await switchToBranch(ctx.branchName);
    } catch {
      ctx.branchName = await createBranchName(message);
      await switchToBranch(ctx.branchName, true);
      threadBranchMap.set(threadId, { branchName: ctx.branchName, hasCommit: false, changes: [] });
      saveThreadMap(threadBranchMap);
    }
  } else {
    ctx.branchName = await createBranchName(message);
    await switchToBranch(ctx.branchName, true);
    threadBranchMap.set(threadId, { branchName: ctx.branchName, hasCommit: false, changes: [] });
    saveThreadMap(threadBranchMap);
  }

  // ── 1. Haiku 플래닝 — 실행 계획 + 안내 메시지 ──
  const plan = await _planSteps({
    message,
    hasImages: !!(images && images.length > 0),
    hasFigma: hasFigma && !!CONFIG.figma.apiKey,
    hasDocs: !!CONFIG.docs.url,
    isFollowUp,
  });

  console.log(`[PLAN] 단계: ${plan.steps.join(" → ")}`);
  console.log(`[PLAN] 메시지: ${plan.message}`);

  // 프론트에 계획 전달 — 동적 프로그레스바 구성용
  emit("plan", { steps: plan.steps, message: plan.message, branchName: ctx.branchName });

  // AI 안내 메시지를 유저에게 스트리밍
  emit("stream", { delta: plan.message });
  emit("stream_end", { content: plan.message });

  // ── 2. stepHandlers — 각 단계의 실행 로직 ──
  const stepHandlers = {
    analyze_image: async () => {
      // 이미지는 ctx.images에 이미 있음 — 이후 generate_code에서 context.images로 전달
      console.log(`[STEP:analyze_image] 이미지 ${ctx.images?.length || 0}장 분석 준비`);
    },

    fetch_figma: async () => {
      try {
        ctx.figmaData = await fetchFigmaData(message);
        console.log(`[STEP:fetch_figma] 피그마 스펙 ${ctx.figmaData?.specs?.length || 0}건`);
      } catch (err) {
        console.warn(`[STEP:fetch_figma] 실패: ${err.message}`);
      }
    },

    analyze_files: async () => {
      const fileTree = collectFileTree(repoPath);
      const initialPaths = await identifyRelevantFiles(message, fileTree, ctx.figmaData);
      ctx.relevantPaths = validateFileSelection(message, initialPaths, fileTree);
      ctx.fileContents = readFiles(ctx.relevantPaths, repoPath);
      console.log(`[STEP:analyze_files] 관련 파일 ${ctx.fileContents.length}개`);
    },

    check_docs: async () => {
      try {
        const docsReady = await ensureDocsRepo();
        if (docsReady) {
          ctx.docsResult = await buildDocsContext(message, ctx.fileContents);
          if (ctx.docsResult?.implStatus?.status === "implemented") {
            await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
            const implResult = {
              type: "already_implemented",
              specIds: ctx.docsResult.specIds,
              implemented: ctx.docsResult.implStatus.implemented,
            };
            await saveMessage({ conversationId, role: "assistant", content: `이미 구현됨: ${ctx.docsResult.implStatus.implemented?.join(", ")}`, type: "already_implemented", metadata: implResult });
            throw { __earlyReturn: implResult };
          }
        }
      } catch (err) {
        if (err.__earlyReturn) throw err;
        console.warn(`[STEP:check_docs] 실패: ${err.message}`);
      }
    },

    generate_code: async () => {
      const threadData = threadBranchMap.get(threadId);
      ctx.context = {
        isFollowUp,
        isFirstCommit: !threadData.hasCommit,
        previousChanges: isFollowUp ? threadData.changes.join("\n---\n") : null,
        threadHistory,
        docsContext: ctx.docsResult?.docsContext || null,
        images,
      };

      const codeResult = await generateCodeChanges(message, ctx.fileContents, ctx.figmaData, ctx.context, repoPath);
      ctx.appliedChanges = codeResult.appliedChanges || [];

      if (ctx.appliedChanges.length === 0) {
        await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
        await saveMessage({ conversationId, role: "assistant", content: "수정할 내용을 찾지 못했어요.", type: "no_changes" });
        throw { __earlyReturn: { type: "no_changes", message: "수정할 내용을 찾지 못했어요." } };
      }
    },

    build: async () => {
      let buildResult = { success: false };
      let buildAttempt = 0;
      while (!buildResult.success && buildAttempt < MAX_LOOP) {
        buildAttempt++;
        buildResult = await runBuild(repoPath);
        if (buildResult.success) break;

        console.log(`[STEP:build] 빌드 실패 (${buildAttempt}/${MAX_LOOP}), AI 수정 시도...`);
        emit("progress", { step: "build", state: "retrying", attempt: buildAttempt, maxAttempt: MAX_LOOP });
        const allPaths = [...new Set([...ctx.relevantPaths, ...ctx.appliedChanges.map((c) => c.filePath)])];
        const currentFiles = readFiles(allPaths, repoPath);
        try {
          const fixResult = await fixBuildError(buildResult.stderr, currentFiles, repoPath);
          ctx.appliedChanges.push(...(fixResult.appliedChanges || []));
        } catch {}
      }

      if (!buildResult.success) {
        await revertChanges(repoPath);
        await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});

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
        throw { __earlyReturn: { type: "build_failed", errorSummary, error: buildResult.stderr.slice(0, 500) } };
      }

      // 빌드 성공 → 체크포인트 커밋 (검증 실패 시 복원용)
      await run("git add -A", repoPath);
      await run('git commit -m "__checkpoint: build passed"', repoPath).catch(() => {});
    },

    verify: async () => {
      const appliedBeforeVerify = [...ctx.appliedChanges];
      let verifyAttempt = 0;
      let verifyPassed = false;
      while (!verifyPassed && verifyAttempt < MAX_LOOP) {
        verifyAttempt++;
        const verification = await verifyChanges(message, ctx.appliedChanges, repoPath);
        if (verification.passed) {
          verifyPassed = true;
          break;
        }

        console.log(`[STEP:verify] 누락 감지 (${verifyAttempt}/${MAX_LOOP}): ${verification.missing}`);
        emit("progress", { step: "verify", state: "retrying", attempt: verifyAttempt, maxAttempt: MAX_LOOP, missing: verification.missing });
        const allPaths = [...new Set([...ctx.relevantPaths, ...ctx.appliedChanges.map((c) => c.filePath)])];
        const currentFiles = readFiles(allPaths, repoPath);
        try {
          const supplementResult = await generateCodeChanges(
            `원래 요청: ${message}\n\n누락된 작업: ${verification.missing}\n\n누락된 부분만 추가로 구현해줘.`,
            currentFiles, ctx.figmaData, ctx.context, repoPath,
          );
          ctx.appliedChanges.push(...(supplementResult.appliedChanges || []));

          const rebuildResult = await runBuild(repoPath);
          if (!rebuildResult.success) {
            console.warn("[STEP:verify] 보완 후 빌드 실패 — 체크포인트로 복원");
            await run("git reset --hard HEAD", repoPath);
            ctx.appliedChanges.length = 0;
            ctx.appliedChanges.push(...appliedBeforeVerify);
            break;
          }
        } catch {
          await run("git reset --hard HEAD", repoPath).catch(() => {});
          ctx.appliedChanges.length = 0;
          ctx.appliedChanges.push(...appliedBeforeVerify);
          break;
        }
      }

      // 체크포인트 언커밋
      await run("git reset --soft HEAD~1", repoPath).catch(() => {});
    },

    push: async () => {
      const changedFiles = [...new Set(ctx.appliedChanges.map((c) => c.filePath))];

      const gitStatus = await run("git status --porcelain", repoPath).catch(() => "");
      if (!gitStatus.trim()) {
        console.warn("[STEP:push] 변경사항 없음 — 커밋 스킵");
        await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});
        await saveMessage({ conversationId, role: "assistant", content: "코드를 수정했지만 최종 반영할 변경사항이 없었어요.", type: "no_changes" });
        throw { __earlyReturn: { type: "no_changes", message: "코드를 수정했지만 최종 반영할 변경사항이 없었어요.", threadId } };
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
      await run(`git push origin ${ctx.branchName}`, repoPath);
      ctx.pushTimestamp = Date.now();

      // 스레드 데이터 업데이트
      const threadData = threadBranchMap.get(threadId);
      threadData.hasCommit = true;
      threadData.changes.push(
        ctx.appliedChanges.map((c) => `${c.type}: ${c.filePath}`).join("\n").slice(0, 500),
      );
      saveThreadMap(threadBranchMap);
    },

    deploy: async () => {
      const previewUrl = await waitForVercelDeployment(ctx.branchName, ctx.pushTimestamp);
      ctx.previewUrl = previewUrl;
    },
  };

  // ── 3. 계획 실행 루프 ──
  const totalSteps = plan.steps.length;
  try {
    for (let i = 0; i < totalSteps; i++) {
      const step = plan.steps[i];
      const handler = stepHandlers[step];
      if (!handler) {
        console.warn(`[PLAN] 알 수 없는 단계: ${step}, 스킵`);
        continue;
      }

      emit("progress", { step, state: "start", current: i + 1, total: totalSteps });
      await handler();
      emit("progress", { step, state: "done", current: i + 1, total: totalSteps });
    }
  } catch (err) {
    if (err.__earlyReturn) return err.__earlyReturn;
    throw err;
  }

  // ── 4. 변경 요약 + DB 저장 ──
  const changedFiles = [...new Set(ctx.appliedChanges.map((c) => c.filePath))];
  const changeSummary = ctx.appliedChanges
    .map((c) => {
      if (c.type === "create") return `생성: ${c.filePath}\n미리보기: ${(c.content || "").slice(0, 200)}`;
      return `수정: ${c.filePath}\n이전: ${(c.oldString || "").slice(0, 100)}\n이후: ${(c.newString || "").slice(0, 100)}`;
    })
    .join("\n---\n");
  const summary = await summarizeChanges(`## 원래 요청\n${message}\n\n## 변경 내역\n${changeSummary}`) || changeSummary;

  await run(`git checkout ${CONFIG.repo.branch}`).catch(() => {});

  const resultData = { type: "success", summary, branchName: ctx.branchName, previewUrl: ctx.previewUrl, changedFiles, threadId };
  await saveMessage({ conversationId, role: "assistant", content: summary, type: "success", metadata: { branchName: ctx.branchName, previewUrl: ctx.previewUrl, changedFiles } });
  await updateConversation(conversationId, { branch_name: ctx.branchName });

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
