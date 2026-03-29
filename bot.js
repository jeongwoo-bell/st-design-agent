const { CONFIG, validateEnv } = require("./src/config");
const { app } = require("./src/slack");

(async () => {
  validateEnv();

  if (!CONFIG.figma.apiKey)
    console.log("⚠️  FIGMA_API_KEY 미설정 — 피그마 비활성화");
  if (!CONFIG.github.token)
    console.log("⚠️  GITHUB_TOKEN 미설정 — PR 자동 생성이 제한될 수 있음");

  await app.start();
  console.log("⚡️ Design Bot v5 (API Direct + Figma REST) 실행 중!");
  console.log(`📁 레포: ${CONFIG.repo.url}`);
  console.log(`🌿 기본 브랜치: ${CONFIG.repo.branch}`);
  console.log(
    CONFIG.figma.apiKey ? "🎨 피그마: REST API 활성화" : "🎨 피그마: 비활성화",
  );
  console.log("🔨 빌드 검증: 활성화 (pnpm build)");
  console.log("🤖 AI: Haiku(파일분석) + Sonnet(코드수정)");
  console.log(
    CONFIG.allowedChannel
      ? `📢 채널 필터: ${CONFIG.allowedChannel}`
      : "📢 모든 채널에서 @멘션에 반응",
  );
  console.log("💡 첫 요청: @멘션으로 말걸기 | 후속: 스레드에서 바로 메시지");
})();
