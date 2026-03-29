// ============================================
// Sonnet API로 코드 수정안 생성 (tool use + 멀티턴)
// ============================================
const fs = require("fs");
const path = require("path");
const { callSonnet } = require("./claude");
const { WIZKEY_SYSTEM_PROMPT } = require("../wizkey-prompt");

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
 */
function buildUserMessage(request, fileContents, figmaData, context) {
  let msg = "";

  if (context?.isFollowUp && context?.previousChanges) {
    msg += `## 이전 수정 이력 (같은 스레드, 같은 브랜치)\n${context.previousChanges}\n\n---\n\n`;
  }

  msg += `## 디자이너 요청\n${request}\n\n`;

  if (figmaData) {
    msg += `## 피그마 디자인 분석 결과\n\`\`\`json\n${JSON.stringify(figmaData.specs, null, 2)}\n\`\`\`\n\n`;
  }

  msg += `## 현재 파일 내용\n\n`;
  for (const file of fileContents) {
    msg += `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
  }

  return msg;
}

/**
 * Sonnet 응답에서 tool_use 호출을 파싱
 * @returns {{ changes: Array, readRequests: Array, textResponse: string }}
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
 * 코드 수정안 생성 (멀티턴: read_file 요청 처리 포함)
 *
 * 대화 컨텍스트를 유지하면서 read_file 요청이 오면 파일을 읽어 tool_result로 전달.
 * 최대 MAX_READBACKS 회까지 반복.
 */
async function generateCodeChanges(
  request,
  fileContents,
  figmaData,
  context,
  repoPath,
) {
  const MAX_READBACKS = 5;
  const allChanges = [];

  const userMessage = buildUserMessage(request, fileContents, figmaData, context);
  const messages = [{ role: "user", content: userMessage }];

  let iterations = 0;

  while (iterations <= MAX_READBACKS) {
    console.log(
      `[CODE-GEN] Sonnet 호출 (턴 ${iterations + 1})...`,
    );
    const response = await callSonnet(WIZKEY_SYSTEM_PROMPT, messages, TOOLS);
    const parsed = parseToolCalls(response);

    allChanges.push(...parsed.changes);

    if (parsed.textResponse) {
      console.log(`[CODE-GEN:텍스트] ${parsed.textResponse.slice(0, 150)}`);
    }
    console.log(
      `[CODE-GEN] 수정 ${parsed.changes.length}건, 추가 읽기 요청 ${parsed.readRequests.length}건`,
    );

    // read_file 요청이 없으면 종료
    if (parsed.readRequests.length === 0) {
      break;
    }

    // 대화 이어가기: assistant 응답을 messages에 추가
    messages.push({ role: "assistant", content: response.content });

    // read_file 요청에 대한 tool_result 생성
    const toolResults = [];
    for (const req of parsed.readRequests) {
      const absPath = path.join(repoPath, req.filePath);
      let fileContent;
      try {
        fileContent = fs.readFileSync(absPath, "utf-8");
        console.log(`[CODE-GEN] 추가 파일 읽기: ${req.filePath}`);
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

    // edit_file, create_file에 대한 tool_result도 보내야 함 (성공 확인)
    for (const change of parsed.changes) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: change.toolUseId,
        content: "적용 완료",
      });
    }

    messages.push({ role: "user", content: toolResults });
    iterations++;
  }

  return allChanges;
}

/**
 * 빌드 에러 수정 요청 (기존 대화 컨텍스트 없이 새로운 요청)
 */
async function fixBuildError(errorMessage, fileContents, repoPath) {
  const request = `빌드 에러가 발생했어. 에러를 수정해줘.

## 빌드 에러 메시지
\`\`\`
${errorMessage}
\`\`\``;

  return generateCodeChanges(request, fileContents, null, null, repoPath);
}

module.exports = { generateCodeChanges, fixBuildError, TOOLS };
