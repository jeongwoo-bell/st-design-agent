const { CONFIG } = require("./config");

function truncateForSlack(text, maxLen = CONFIG.slackMaxLength) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (이하 생략)";
}

async function createBranchName(message) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: `다음 디자인 수정 요청을 영문 git 브랜치명으로 변환해. design/ 접두사 포함, 소문자 kebab-case, 최대 40자. 브랜치명만 출력해.

요청: "${message}"`,
          },
        ],
      }),
    });
    const data = await res.json();
    const name = (data.content?.[0]?.text || "").trim();
    if (name && name.startsWith("design/") && name.length <= 50) {
      return name;
    }
  } catch (err) {
    console.log(`[BRANCH] AI 브랜치명 생성 실패, 폴백 사용: ${err.message}`);
  }
  // 폴백: 기존 방식
  const timestamp = Date.now();
  const slug = message
    .replace(/[^a-zA-Z0-9가-힣]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30);
  return `design/request-${timestamp}-${slug}`;
}

function parseClaudeOutput(output) {
  if (output.includes("NOT_FOUND")) return { status: "not_found", output };
  if (output.includes("NOT_CODE_REQUEST"))
    return { status: "not_code", output };
  if (output.includes("BUILD_FAILED"))
    return { status: "build_failed", output };
  if (output.includes("FIGMA_MCP_FAILED"))
    return { status: "figma_failed", output };
  return { status: "ok", output };
}

function extractPrUrl(output) {
  const match = output.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
  return match ? match[0] : null;
}

function containsFigmaLink(text) {
  return /figma\.com\/(design|file)\//.test(text);
}

module.exports = {
  truncateForSlack,
  createBranchName,
  parseClaudeOutput,
  extractPrUrl,
  containsFigmaLink,
};
