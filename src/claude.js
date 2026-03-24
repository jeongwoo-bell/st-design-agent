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

module.exports = { runClaudeCode };
