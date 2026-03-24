const { CONFIG } = require("./config");

function truncateForSlack(text, maxLen = CONFIG.slackMaxLength) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (이하 생략)";
}

function createBranchName(message) {
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
