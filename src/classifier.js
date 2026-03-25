const Anthropic = require("@anthropic-ai/sdk");
const { CONFIG } = require("./config");

const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });

const SYSTEM_PROMPT = `너는 슬랙 메시지 분류기야. 유저의 메시지를 읽고 아래 3가지 중 하나로 분류해.

1. "code" - 화면 구현, UI 퍼블리싱, 컴포넌트 수정, 스타일 변경, 피그마 링크 포함 등 실제 코드 작업이 필요한 요청
   예: "Section3 타이틀 크기 키워줘", "헤더 배경색 바꿔줘", "피그마 링크대로 구현해줘", "버튼 추가해줘"

2. "chat" - 코드 수정이 필요 없는 질문이나 대화. 로직 질문, UI 관련 조언, 일반 질문 등
   예: "React에서 상태관리 어떻게 해?", "이 컴포넌트 구조 어때?", "flex와 grid 차이가 뭐야?", "안녕"

3. "unclear" - 의도를 파악하기 어려운 모호한 메시지
   예: "음...", "그거", "ㅇㅇ"

반드시 "code", "chat", "unclear" 중 하나만 출력해. 다른 말은 하지 마.`;

async function classifyMessage(userMessage) {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const result = response.content[0].text.trim().toLowerCase();

    if (["code", "chat", "unclear"].includes(result)) {
      return result;
    }
    return "unclear";
  } catch (err) {
    console.error("[CLASSIFIER] 분류 실패, code로 폴백:", err.message);
    return "code";
  }
}

const TMI_SYSTEM = `너는 대기 화면에 짧은 한 줄을 보여주는 봇이야.
아재개그, 생활 꿀팁, 쓸데없는 TMI 중 하나를 랜덤으로 골라서 한 줄만 출력해.
- 반드시 한 줄, 50자 이내
- "TMI:" 로 시작하고, 이모지 없이 텍스트만
- 예시: "TMI: 개구리는 물을 마실 때 눈을 감는다"
- 예시: "TMI: 알루미늄 호일의 반짝이는 면이 바깥쪽이어야 열 반사가 더 잘 된다"
- 예시: "TMI: 시간은 금이다. 그래서 ATM에서 인출이 되나?"
다른 말 없이 한 줄만 출력해.`;

async function generateTmi() {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: TMI_SYSTEM,
      messages: [{ role: "user", content: "하나 알려줘" }],
    });
    return response.content[0].text.trim();
  } catch (err) {
    console.error("[TMI] 생성 실패:", err.message);
    return null;
  }
}

const SUMMARIZE_SYSTEM = `너는 코드 수정 결과를 디자이너에게 알려주는 봇이야.
Claude Code의 작업 로그를 받아서, 디자이너가 이해하기 쉬운 요약으로 바꿔줘.

## 규칙
- 기술 용어(커밋 해시, 빌드, git, 브랜치 등)는 빼고 "뭐가 바뀌었는지"만 알려줘
- 슬랙 mrkdwn 형식으로 작성해 (마크다운 헤더 # 쓰지 마)
- 변경사항을 • 리스트로 간결하게 정리
- 파일 경로가 나오면 어떤 화면/섹션인지 자연어로 설명
- 3~5줄 이내로 요약
- 다른 인사말이나 부연설명 없이 변경 요약만 출력

## 예시 출력
• FAQ 섹션에 "테스트는 총 몇 문항인가요?" 항목 추가
• /time 경로에 실시간 시계 페이지 생성`;

async function summarizeChanges(claudeOutput) {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: SUMMARIZE_SYSTEM,
      messages: [{ role: "user", content: claudeOutput }],
    });
    return response.content[0].text.trim();
  } catch (err) {
    console.error("[SUMMARIZE] 요약 실패:", err.message);
    return null;
  }
}

module.exports = { classifyMessage, generateTmi, summarizeChanges };
