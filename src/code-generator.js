// ============================================
// Sonnet API로 코드 수정안 생성 (tool use + 멀티턴)
// ============================================
const fs = require("fs");
const path = require("path");
const { callSonnet } = require("./claude");
const { WIZKEY_SYSTEM_PROMPT } = require("../wizkey-prompt");
const { applyChanges } = require("./builder");

// 토큰 안전장치: 1토큰 ≈ 4자 기준, Sonnet 200K 한도의 75%
const MAX_CHAR_BUDGET = 150000 * 4; // 600K자

const TOOLS = [
  {
    name: "edit_file",
    description:
      "기존 파일의 특정 부분을 수정한다. old_string은 파일에서 정확히 일치하는 부분이어야 한다.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "수정할 파일의 상대 경로" },
        old_string: {
          type: "string",
          description: "교체할 기존 코드 (정확히 일치해야 함)",
        },
        new_string: { type: "string", description: "교체할 새 코드" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "create_file",
    description: "새 파일을 생성한다. 기존 파일이 있으면 덮어쓴다.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "생성할 파일의 상대 경로" },
        content: { type: "string", description: "파일 전체 내용" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "read_file",
    description:
      "추가로 읽어야 할 파일 요청. 처음 제공된 파일 외에 더 필요한 경우에만 사용.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "읽을 파일의 상대 경로",
        },
      },
      required: ["file_path"],
    },
  },
];

/**
 * 유저 메시지 빌드: 요청 + 파일 내용 + 피그마 데이터 + 컨텍스트
 * 토큰 안전장치 포함
 */
function buildUserMessage(request, fileContents, figmaData, context) {
  let msg = "";

  if (context?.threadHistory) {
    msg += `## 대화 맥락\n${context.threadHistory}\n\n---\n\n`;
  }

  if (context?.isFollowUp && context?.previousChanges) {
    msg += `## 이전 수정 이력 (같은 브랜치)\n${context.previousChanges}\n\n---\n\n`;
  }

  if (context?.docsContext) {
    msg += `${context.docsContext}\n\n---\n\n`;
  }

  msg += `## 디자이너 요청\n${request}\n\n`;

  if (figmaData) {
    msg += `## 피그마 디자인 분석 결과\n\`\`\`json\n${JSON.stringify(figmaData.specs, null, 2)}\n\`\`\`\n\n`;
  }

  // 파일 내용 — 토큰 예산 체크하면서 추가
  msg += `## 현재 파일 내용\n\n`;
  let charBudget = MAX_CHAR_BUDGET - msg.length;

  // 파일을 크기순으로 정렬 (작은 것 먼저 → 최대한 많이 포함)
  const sortedFiles = [...fileContents].sort((a, b) => a.content.length - b.content.length);

  for (const file of sortedFiles) {
    const entry = `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
    if (entry.length <= charBudget) {
      msg += entry;
      charBudget -= entry.length;
    } else if (charBudget > 1000) {
      // 예산 부족하면 잘라서라도 포함
      const truncated = file.content.slice(0, charBudget - 200);
      msg += `### ${file.path} (일부 — 전체 필요 시 read_file 사용)\n\`\`\`\n${truncated}\n...(truncated)\n\`\`\`\n\n`;
      charBudget = 0;
    } else {
      msg += `### ${file.path} (파일이 너무 커서 생략 — read_file로 요청하세요)\n\n`;
    }
  }

  return msg;
}

/**
 * Sonnet 응답에서 tool_use 호출을 파싱
 */
function parseToolCalls(response) {
  const changes = [];
  const readRequests = [];
  let textResponse = "";

  for (const block of response.content) {
    if (block.type === "tool_use") {
      if (block.name === "edit_file") {
        changes.push({
          type: "edit",
          toolUseId: block.id,
          filePath: block.input.file_path,
          oldString: block.input.old_string,
          newString: block.input.new_string,
        });
      } else if (block.name === "create_file") {
        changes.push({
          type: "create",
          toolUseId: block.id,
          filePath: block.input.file_path,
          content: block.input.content,
        });
      } else if (block.name === "read_file") {
        readRequests.push({
          toolUseId: block.id,
          filePath: block.input.file_path,
        });
      }
    } else if (block.type === "text") {
      textResponse += block.text;
    }
  }

  return { changes, readRequests, textResponse };
}

/**
 * 코드 수정안 생성 (멀티턴: 즉시 디스크 적용 + read_file 처리)
 *
 * 변경사항은 멀티턴 중 즉시 디스크에 적용됨.
 * 성공/실패를 tool_result로 Sonnet에 피드백.
 *
 * @returns {{ appliedChanges: Array, failedChanges: Array }}
 */
async function generateCodeChanges(
  request,
  fileContents,
  figmaData,
  context,
  repoPath,
  emit,
) {
  const _emit = typeof emit === "function" ? emit : () => {};
  const MAX_READBACKS = 10;
  const appliedChanges = [];
  const failedChanges = [];

  const userMessage = buildUserMessage(request, fileContents, figmaData, context);

  // 이미지가 있으면 multimodal content 구성
  let firstMessageContent;
  if (context?.images && context.images.length > 0) {
    firstMessageContent = [];
    // 이미지 먼저
    for (const img of context.images) {
      firstMessageContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
    // 텍스트 뒤에
    firstMessageContent.push({ type: "text", text: userMessage });
  } else {
    firstMessageContent = userMessage;
  }

  const messages = [{ role: "user", content: firstMessageContent }];

  let iterations = 0;

  while (iterations <= MAX_READBACKS) {
    console.log(`[CODE-GEN] Sonnet 호출 (턴 ${iterations + 1})...`);
    const response = await callSonnet(WIZKEY_SYSTEM_PROMPT, messages, TOOLS);
    const parsed = parseToolCalls(response);

    if (parsed.textResponse) {
      console.log(`[CODE-GEN:텍스트] ${parsed.textResponse.slice(0, 150)}`);
    }
    console.log(
      `[CODE-GEN] 수정 ${parsed.changes.length}건, 추가 읽기 요청 ${parsed.readRequests.length}건`,
    );

    // read_file도 없고 changes도 없으면 종료
    if (parsed.readRequests.length === 0 && parsed.changes.length === 0) {
      break;
    }

    // 대화 이어가기: assistant 응답을 messages에 추가
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];

    // edit/create — 즉시 디스크에 적용하고 결과를 tool_result로
    for (const change of parsed.changes) {
      const result = await applyChanges([change], repoPath);
      if (result.applied.length > 0) {
        appliedChanges.push(change);
        toolResults.push({
          type: "tool_result",
          tool_use_id: change.toolUseId,
          content: "적용 완료",
        });
        console.log(`[CODE-GEN] ✅ 적용 성공: ${change.filePath}`);
        _emit("log", { step: "generate_code", message: `${change.filePath} 수정 완료` });
      } else {
        failedChanges.push(change);
        const reason = result.failed[0]?.reason || "알 수 없는 오류";
        toolResults.push({
          type: "tool_result",
          tool_use_id: change.toolUseId,
          content: `적용 실패: ${reason}. 파일의 현재 내용을 read_file로 다시 읽고 올바른 old_string으로 재시도해.`,
          is_error: true,
        });
        console.log(`[CODE-GEN] ❌ 적용 실패: ${change.filePath} — ${reason}`);
        _emit("log", { step: "generate_code", message: `${change.filePath} 재시도 중` });
      }
    }

    // read_file — 디스크에서 읽어서 반환 (이전 턴의 edit가 반영된 최신 상태)
    for (const req of parsed.readRequests) {
      const absPath = path.join(repoPath, req.filePath);
      let fileContent;
      try {
        fileContent = fs.readFileSync(absPath, "utf-8");
        console.log(`[CODE-GEN] 📖 추가 파일 읽기: ${req.filePath}`);
        _emit("log", { step: "generate_code", message: `${req.filePath} 분석 중` });
      } catch (err) {
        fileContent = `파일을 읽을 수 없습니다: ${err.message}`;
        console.warn(`[CODE-GEN] 추가 파일 읽기 실패: ${req.filePath}`);
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: req.toolUseId,
        content: fileContent,
      });
    }

    // read_file도 changes도 없었으면 (텍스트만) 종료
    if (toolResults.length === 0) break;

    messages.push({ role: "user", content: toolResults });
    iterations++;
  }

  console.log(`[CODE-GEN] 완료 — 적용 ${appliedChanges.length}건, 실패 ${failedChanges.length}건`);
  return { appliedChanges, failedChanges };
}

/**
 * 빌드 에러 수정 요청
 */
async function fixBuildError(errorMessage, fileContents, repoPath, emit) {
  const request = `빌드 에러가 발생했어. 에러를 수정해줘.

## 빌드 에러 메시지
\`\`\`
${errorMessage}
\`\`\``;

  return generateCodeChanges(request, fileContents, null, null, repoPath, emit);
}

module.exports = { generateCodeChanges, fixBuildError, TOOLS };
