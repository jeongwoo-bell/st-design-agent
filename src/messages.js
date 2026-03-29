const MESSAGES = {
  // 안내
  GUIDE:
    "SleepThera 랜딩페이지에 대해 궁금한 점 또는 구현하고 싶은 부분을 말씀해주세요!",

  // 분류 결과
  UNCLEAR:
    "🤔 요청을 이해하지 못했어요.\nSleepThera 랜딩페이지에 대해 궁금한 점 또는 구현하고 싶은 부분을 말씀해주세요!",
  NOT_CODE:
    "🤔 코드 수정 요청이 아닌 것 같아요. SleepThera 랜딩페이지에 대해 궁금한 점 또는 구현하고 싶은 부분을 말씀해주세요!",

  // 진행 상태
  QUEUE: (count) => `⏳ 앞에 ${count}개 요청이 있어요. 순서대로 처리할게요!`,
  START_FIGMA: "🎨 피그마 링크를 감지했어요! 디자인 분석 후 구현할게요...",
  START_FOLLOWUP: "🔧 같은 브랜치에서 이어서 수정할게요...",
  START_NEW: "🔧 요청을 받았어요! 브랜치 생성 중...",
  FIGMA_NO_KEY:
    "⚠️ 피그마 MCP가 설정되어 있지 않아요. 관리자에게 FIGMA_API_KEY 설정을 요청해주세요!\n텍스트로 수정 내용을 설명해주시면 그걸로 진행할게요.",
  CLAUDE_RUNNING_FIGMA:
    "🤖 피그마 디자인을 분석하고 구현 중이에요...",
  CLAUDE_RUNNING:
    "🤖 코드를 수정하고 있어요...\n(수정 → 빌드 검증 → 커밋 → 푸시까지 자동으로 진행돼요)",
  VERCEL_WAITING: "🚀 Vercel 배포 대기 중...",
  PR_CREATING: "🔀 Draft PR 생성 중...",

  // 에러
  TIMEOUT:
    "⏰ 작업이 너무 오래 걸려서 중단됐어요. 요청을 더 작게 나눠서 다시 시도해주세요!",
  NOT_FOUND: (detail) =>
    `🔍 수정할 대상을 찾지 못했어요.\n\n${detail}\n\n좀 더 구체적으로 알려주시면 다시 시도할게요!`,
  BUILD_FAILED: (detail) =>
    `🔨 빌드가 실패해서 수정을 되돌렸어요.\n\n${detail}\n\n다른 방식으로 요청해주시면 다시 시도할게요!`,
  FIGMA_FAILED:
    "🎨 피그마 디자인 데이터를 가져오지 못했어요.\n텍스트로 수정 내용을 설명해주시면 바로 반영할게요!",
  CLAUDE_ERROR: (detail) => `❌ AI 실행 중 오류: ${detail}`,
  AUTH_ERROR: "🔑 GitHub 인증에 문제가 있어요. 관리자에게 알려주세요!",
  CONFLICT_ERROR: "⚠️ Git 충돌이 발생했어요. 개발팀에 알려주세요!",
  DISK_ERROR: "💾 서버 디스크 용량이 부족해요. 관리자에게 알려주세요!",
  GENERIC_ERROR: (detail) => `❌ 에러가 발생했어요: ${detail}`,
  PR_ERROR: (detail) => `❌ PR 생성 중 에러: ${detail}`,
  NO_COMMIT:
    "⚠️ 이 스레드에서 아직 푸시된 커밋이 없어요. 먼저 수정 요청을 해주세요!",

  // 결과
  RESULT_FOOTER_WITH_PREVIEW:
    "위 프리뷰 링크에서 확인해주세요! 추가 수정이 필요하면 이 스레드에서 말씀해주세요.\nPR 생성이 필요하면 `/pr` 이라고 입력해주세요.",
  RESULT_FOOTER:
    "추가 수정이 필요하면 이 스레드에서 말씀해주세요.\nPR 생성이 필요하면 `/pr` 이라고 입력해주세요.",
};

module.exports = { MESSAGES };
