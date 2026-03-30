const Anthropic = require("@anthropic-ai/sdk");
const { CONFIG } = require("./config");

const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });

const SYSTEM_PROMPT = `너는 슬랙 메시지 분류기야. 유저의 메시지를 읽고 아래 4가지 중 하나로 분류해.

1. "code" - 화면 구현, UI 퍼블리싱, 컴포넌트 수정, 스타일 변경, 피그마 링크 포함 등 실제 코드 작업이 필요한 요청
   예: "Section3 타이틀 크기 키워줘", "헤더 배경색 바꿔줘", "피그마 링크대로 구현해줘", "버튼 추가해줘"

2. "ask" - 코드 수정은 아니지만 프로젝트 코드, 기술, 구조에 대한 질문. 코드를 참고해야 답변할 수 있는 질문
   예: "React에서 상태관리 어떻게 해?", "이 컴포넌트 구조 어때?", "flex와 grid 차이가 뭐야?", "Header 컴포넌트 어디있어?", "이 프로젝트 폴더 구조 알려줘"

3. "talk" - 일반 대화, 인사, 잡담, 농담 등 코드와 무관한 가벼운 대화
   예: "안녕", "뭐해?", "오늘 날씨 좋다", "ㅋㅋㅋ", "고마워", "점심 뭐 먹지", "심심해"

4. "unclear" - 의도를 파악하기 어려운 모호한 메시지
   예: "음...", "그거", "ㅇㅇ"

반드시 "code", "ask", "talk", "unclear" 중 하나만 출력해. 다른 말은 하지 마.`;

async function classifyMessage(userMessage) {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const result = response.content[0].text.trim().toLowerCase();

    if (["code", "ask", "talk", "unclear"].includes(result)) {
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
변경 내역을 받아서, 디자이너가 이해하기 쉬운 상세한 요약으로 바꿔줘.

## 규칙
- 기술 용어(커밋 해시, 빌드, git, 브랜치 등)는 빼고 "뭐가 바뀌었는지"만 알려줘
- 슬랙 mrkdwn 형식으로 작성해 (마크다운 헤더 # 쓰지 마)
- 변경사항을 • 리스트로 정리
- 파일 경로가 나오면 어떤 화면/섹션인지 자연어로 설명
- 새 파일이 생성됐으면 어떤 화면/기능이 추가됐는지 구체적으로 설명
- 기존 파일이 수정됐으면 뭐가 어떻게 바뀌었는지 설명 (예: 헤더에 운세 버튼 추가)
- 다른 인사말이나 부연설명 없이 변경 요약만 출력

## 예시 출력
• 운세 페이지 생성 (/fortune 경로)
• FortuneSection 컴포넌트 추가 (랜덤 운세 표시 기능)
• 헤더에 "오늘의 운세" 버튼 추가 → /fortune 페이지로 이동`;

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

const VERIFY_SYSTEM = `너는 코드 수정 검증기야. 사용자의 요청과 실제 변경 내역을 비교해서 누락된 작업이 있는지 확인해.

## 규칙
- 사용자 요청에 포함된 모든 작업이 변경 내역에 반영되었는지 확인해
- 누락된 게 없으면 "PASS"만 출력해
- 누락된 게 있으면 "FAIL: " 뒤에 누락된 작업을 구체적으로 나열해
- "PASS" 또는 "FAIL: ..." 외에 다른 말은 하지 마

## 체크포인트
- 새 페이지 생성 요청 → page.tsx가 있는가?
- 컴포넌트 생성 → 해당 컴포넌트 파일이 있는가?
- 헤더/네비게이션 연결 요청 → Header 등 네비게이션 파일이 수정되었는가?
- 기존 파일 수정 요청 → 해당 파일의 edit가 있는가?
- import한 모듈 → 해당 파일이 생성/존재하는가?

## 예시
요청: "운세 페이지 만들고 헤더에 버튼 연결해줘"
변경: 생성 src/app/fortune/page.tsx, 생성 src/components/Sections/FortuneSection/index.tsx
→ FAIL: 헤더에 운세 페이지 이동 버튼이 추가되지 않음

요청: "Section3 타이틀 크기 키워줘"
변경: 수정 src/components/Sections/Section3/index.tsx
→ PASS`;

async function verifyChanges(userRequest, changes) {
  try {
    const changeSummary = changes
      .map((c) => `${c.type === "create" ? "생성" : "수정"}: ${c.filePath}`)
      .join("\n");

    const prompt = `## 사용자 요청\n${userRequest}\n\n## 변경 내역\n${changeSummary}`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: VERIFY_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });

    const result = response.content[0].text.trim();
    console.log(`[VERIFY] 결과: ${result}`);

    if (result.startsWith("PASS")) {
      return { passed: true, missing: null };
    }

    const missing = result.replace(/^FAIL:\s*/, "");
    return { passed: false, missing };
  } catch (err) {
    console.error("[VERIFY] 검증 실패, PASS로 폴백:", err.message);
    return { passed: true, missing: null };
  }
}

module.exports = { classifyMessage, generateTmi, summarizeChanges, verifyChanges };
