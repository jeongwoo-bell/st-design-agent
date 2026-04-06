const MESSAGES = {
  // 안내
  GUIDE:
    "SleepThera 랜딩페이지에 대해 궁금한 점 또는 구현하고 싶은 부분을 말씀해주세요!",

  // 분류 결과
  UNCLEAR:
    "🤔 요청을 이해하지 못했어요.\nSleepThera 랜딩페이지에 대해 궁금한 점 또는 구현하고 싶은 부분을 말씀해주세요!",

  // 진행 상태
  QUEUE: (count) => `⏳ 앞에 ${count}개 요청이 있어요. 순서대로 처리할게요!`,
  FIGMA_NO_KEY:
    "⚠️ 피그마 MCP가 설정되어 있지 않아요. 관리자에게 FIGMA_API_KEY 설정을 요청해주세요!\n텍스트로 수정 내용을 설명해주시면 그걸로 진행할게요.",
  PR_CREATING: "🔀 Draft PR 생성 중...",

  // 에러
  TIMEOUT:
    "⏰ 작업이 너무 오래 걸려서 중단됐어요. 요청을 더 작게 나눠서 다시 시도해주세요!",
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

  // 채팅/질문 에러
  ANSWER_ERROR: "답변 생성 중 오류가 발생했어요. 다시 시도해주세요!",

  // 코드 수정
  NO_CHANGES: "수정할 내용을 찾지 못했어요. 좀 더 구체적으로 요청해주세요!",
  APPLY_FAILED: "수정사항을 적용하지 못했어요. 다시 시도해주세요.",

  // JIRA 티켓
  TICKET_EMPTY: "🎫 현재 미완료 티켓이 없어요!",
  TICKET_QUERY_ERROR: "🎫 티켓 조회 중 오류가 발생했어요. 다시 시도해주세요!",
  TICKET_NO_SELECTION:
    "선택된 티켓이 없어요. 번호 이모지를 먼저 누른 뒤 ✅ 를 눌러주세요!",
  TICKET_NO_STATUS_SELECTION:
    "상태를 선택해주세요. 번호 이모지를 먼저 누른 뒤 ✅ 를 눌러주세요!",
  TICKET_TRANSITION_RESULT: (results) =>
    `🎫 상태 전환 결과:\n\n${results.join("\n")}`,
  TICKET_START: (keys) =>
    `🎫 ${keys.join(", ")} 티켓 작업을 시작할게요!`,
  TICKET_NO_LINK: "🎫 이 스레드에 연결된 JIRA 티켓이 없어요.",
  TICKET_FETCH_ERROR: "🎫 티켓 정보를 가져올 수 없어요.",
  TICKET_NO_TRANSITION: "🎫 이 티켓의 상태를 변경할 수 있는 전환이 없어요.",

  // 피그마 링크 확인
  FIGMA_ASK:
    "🎨 이 티켓에 피그마 디자인이 없어요.\n피그마 링크가 있으면 이 스레드에 붙여넣은 뒤 ✅를 눌러주세요.\n없으면 ❌를 눌러주세요. (스펙 문서 기반으로 구현)",
  FIGMA_LINK_MISSING:
    "🎨 스레드에서 피그마 링크를 찾지 못했어요. 링크를 먼저 붙여넣은 뒤 다시 ✅를 눌러주세요!",

  // docs 스펙 문서
  ALREADY_IMPLEMENTED: (specIds, implemented) =>
    `✅ 스펙 ${specIds.join(", ")}은(는) 이미 구현되어 있어요!\n\n구현 항목:\n${implemented.map((i) => `• ${i}`).join("\n")}\n\n추가 수정이 필요하면 구체적으로 말씀해주세요.`,
};

module.exports = { MESSAGES };
