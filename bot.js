const { CONFIG, validateEnv } = require("./src/config");
const { app } = require("./src/slack");

(async () => {
  validateEnv();

  if (!CONFIG.figma.apiKey)
    console.log("⚠️  FIGMA_API_KEY 미설정 — 피그마 비활성화");
  if (!CONFIG.github.token)
    console.log("⚠️  GITHUB_TOKEN 미설정 — PR 자동 생성이 제한될 수 있음");
  if (!CONFIG.jira.host || !CONFIG.jira.apiToken)
    console.log("⚠️  JIRA 미설정 — 티켓 연동 비활성화");
  if (!CONFIG.docs.url)
    console.log("⚠️  DOCS_REPO_URL 미설정 — 스펙 문서 연동 비활성화");

  await app.start();
  console.log("Design Bot 실행 중");
})();
