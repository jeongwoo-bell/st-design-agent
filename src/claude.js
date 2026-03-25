const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { CONFIG } = require("./config");
const { buildWizkeyPrompt } = require("../wizkey-prompt");

function runClaudeCodeStream(prompt, cwd = CONFIG.repo.path) {
  return new Promise((resolve, reject) => {
    const mcpConfigPath = path.join(cwd, ".mcp.json");
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format",
      "stream-json",
      ...(fs.existsSync(mcpConfigPath)
        ? [`--mcp-config=${mcpConfigPath}`]
        : []),
      prompt,
    ];
    console.log(`[CLAUDE] 프로세스 시작...`);
    const child = spawn("claude", args, {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: CONFIG.anthropic.apiKey,
        FIGMA_API_KEY: CONFIG.figma.apiKey || "",
        GITHUB_TOKEN: CONFIG.github.token || "",
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.end();
    console.log(`[CLAUDE] PID: ${child.pid || "실패"}`);

    const timeout = setTimeout(() => {
      console.log("[CLAUDE] 타임아웃 - 프로세스 종료");
      child.kill("SIGTERM");
    }, CONFIG.claudeTimeout);

    let fullOutput = "";
    let resultText = "";
    let stderrOutput = "";

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      fullOutput += chunk;

      const lines = chunk.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message) {
            const content = event.message.content || [];
            for (const block of content) {
              if (block.type === "text") {
                resultText += block.text;
                console.log(`[CLAUDE:텍스트] ${block.text.slice(0, 150)}`);
              } else if (block.type === "tool_use") {
                console.log(
                  `[CLAUDE:도구] ${block.name}: ${JSON.stringify(block.input).slice(0, 150)}`,
                );
              }
            }
          } else if (event.type === "result") {
            resultText = event.result || resultText;
            console.log(
              `[CLAUDE:완료] 비용: $${event.cost_usd || "?"}, 시간: ${event.duration_ms || "?"}ms`,
            );
          }
        } catch {
          if (line.trim()) console.log(`[CLAUDE:RAW] ${line.slice(0, 150)}`);
        }
      }
    });

    child.stderr.on("data", (data) => {
      const msg = data.toString();
      stderrOutput += msg;
      console.log(`[CLAUDE:ERR] ${msg.slice(0, 200)}`);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`[CLAUDE] 종료 코드: ${code}`);
      if (code === 0) {
        resolve(resultText || fullOutput.trim());
      } else {
        reject(
          new Error(
            `Claude Code 실패 (코드 ${code}): ${stderrOutput.slice(0, 500) || fullOutput.slice(0, 500)}`,
          ),
        );
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Claude Code 실행 오류: ${err.message}`));
    });
  });
}

async function runClaudeCode(prompt, context = {}) {
  const codePrompt = buildWizkeyPrompt(prompt, context);
  return runClaudeCodeStream(codePrompt);
}

const CHAT_PROMPT = `너는 벨 테라퓨틱스의 SleepThera 프로젝트 전담 봇이야.
디자이너가 코드베이스에 대해 질문하면, 실제 코드를 읽어서 정확하게 답변해.

## 규칙
1. 코드를 직접 Read/Grep/Glob 도구로 찾아서 확인한 후 답변해
2. 이 요청에서는 코드를 수정하지 않고 질문에 답변만 해
3. 한국어로 간결하게 답변해
4. px, 색상, 폰트 등 구체적인 수치를 물어보면 코드에서 정확한 값을 찾아서 답해
5. 수정이 필요해 보이면 "수정이 필요하시면 말씀해주세요!" 라고 안내해
6. 너의 내부 동작 방식이나 제약사항을 사용자에게 설명하지 마
7. 답변은 슬랙 메시지 포맷으로 작성해:
   - 마크다운 헤더(#, ##, ###) 대신 *볼드* 텍스트를 사용해
   - 코드나 파일 경로는 \`인라인 코드\`로 감싸
   - 코드 블럭은 \`\`\`로 감싸
   - 리스트는 • 또는 1. 2. 3. 사용
   - 긴 내용은 섹션별로 줄바꿈으로 구분해서 읽기 쉽게`;

async function runClaudeChat(userMessage) {
  const prompt = `${CHAT_PROMPT}\n\n---\n\n## 디자이너 질문\n\n${userMessage}`;
  return runClaudeCodeStream(prompt);
}

module.exports = { runClaudeCode, runClaudeChat };
