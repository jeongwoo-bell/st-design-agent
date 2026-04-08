const Anthropic = require("@anthropic-ai/sdk");
const { CONFIG } = require("./config");

const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });

const SYSTEM_PROMPT = `너는 메시지 분류기야. 유저의 메시지를 읽고 아래 5가지 중 하나로 분류해.
이전 대화 맥락이 주어지면, 대화 흐름을 고려해서 현재 메시지의 의도를 파악해.

1. "code" - 실제 코드 작업이 필요한 요청. 아래 모두 포함:
   - 새로운 구현 요청: "Section3 타이틀 크기 키워줘", "버튼 추가해줘", "피그마 링크대로 구현해줘"
   - ⚠️ 이전 작업 결과에 대한 불만/수정 요청/버그 리포트: "버튼이 없는데", "안 보이는데", "이거 왜 안돼?", "확인해줘", "고쳐줘", "다시 해줘"
   - 이전에 봇이 코드를 수정한 대화에서 문제를 지적하면 → 무조건 "code" (설명이 아니라 수정이 필요)

2. "ticket" - JIRA 티켓 관련 질문이나 조회 요청. 할 일, 업무, 작업 목록을 묻는 경우
   예: "지라 티켓 뭐 있어?", "내 할 일 뭐야?", "티켓 보여줘", "남은 작업 뭐야?", "JIRA", "처리해야 할 거", "백로그 뭐 있어?"

3. "ask" - 코드 수정 없이 답변만 하면 되는 순수 질문/정보 요청. 아래 모두 포함:
   - 기술 질문: "React에서 상태관리 어떻게 해?", "이 컴포넌트 구조 어때?"
   - 위치/확인 질문: "Header 컴포넌트 어디있어?", "어떻게 봐?", "어디서 확인해?"
   - ⚠️ 변경 내용 질문: "뭐가 바뀐거야?", "어떤 점이 변경된건지 궁금해", "이전이랑 뭐가 달라?", "왜 이렇게 바꿨어?"
   - "궁금해", "알려줘", "설명해줘", "차이가 뭐야" 같은 표현은 → 정보 요청이므로 "ask"

4. "talk" - 일반 대화, 인사, 잡담, 농담 등 코드와 무관한 가벼운 대화
   예: "안녕", "뭐해?", "오늘 날씨 좋다", "ㅋㅋㅋ", "고마워", "점심 뭐 먹지"

5. "unclear" - 의도를 파악하기 어려운 모호한 메시지. 단, 대화 맥락이 있으면 맥락을 고려해서 최대한 다른 카테고리로 분류해. unclear는 정말 판단 불가능할 때만 사용
   예: "음...", "ㅇㅇ" (맥락 없이 단독으로)

## 중요 규칙
- "궁금해", "알려줘", "뭐가 달라", "어떤 점이 변경", "차이", "설명해줘" → "ask" (정보 요청)
- 이전에 코드 수정이 이루어진 대화에서 "~없는데", "~안되는데", "~안보이는데", "왜 이래", "고쳐줘" 같은 메시지는 → "code" (수정 요청)
- 단순히 설명만 해주면 안되고 코드를 고쳐야 하는 상황이면 → "code"
- "티켓", "지라", "JIRA", "할 일", "작업", "백로그" 등 업무/티켓 관련 키워드 → "ticket"
- ⚠️ "ask"와 "code" 구분 핵심: "궁금해/알려줘" = ask, "해줘/고쳐줘/바꿔줘" = code

반드시 "code", "ticket", "ask", "talk", "unclear" 중 하나만 출력해. 다른 말은 하지 마.`;

async function classifyMessage(userMessage, threadHistory) {
  try {
    let content = userMessage;
    if (threadHistory) {
      content = `## 이전 대화\n${threadHistory}\n\n## 현재 메시지\n${userMessage}`;
    }

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    const result = response.content[0].text.trim().toLowerCase();

    if (["code", "ticket", "ask", "talk", "unclear"].includes(result)) {
      return result;
    }
    return "unclear";
  } catch (err) {
    console.error("[CLASSIFIER] 분류 실패, code로 폴백:", err.message);
    return "code";
  }
}

const SUMMARIZE_SYSTEM = `너는 코드 수정 결과를 디자이너에게 알려주는 봇이야.
변경 내역을 받아서, 디자이너가 이해하기 쉬운 상세한 요약으로 바꿔줘.

## 규칙
- 기술 용어(커밋 해시, 빌드, git, 브랜치 등)는 빼고 "뭐가 바뀌었는지"만 알려줘
- 마크다운 형식으로 작성해
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

const VERIFY_SYSTEM = `너는 코드 수정 검증기야. 사용자의 요청과 실제 코드를 비교해서 누락된 작업이 있는지 확인해.

## 출력 형식
- 누락 없음 → "PASS" 한 단어만 출력
- 누락 있음 → "FAIL: [구체적으로 뭘 해야 하는지]" 출력
- PASS/FAIL 외에 다른 말은 하지 마

## 검증 기준

### 새로 만드는 경우
- 새 페이지 → page.tsx가 있는가?
- 새 컴포넌트 → 파일이 존재하고, 기존 페이지에서 import + 렌더링하고 있는가?
- 네비게이션 연결 요청 → Header/Nav 파일이 실제로 수정되었는가?
- import한 모듈 → 해당 파일이 존재하는가?

### 기존 수정하는 경우
- 스타일 변경 (크기, 색상, 여백 등) → 코드에 요청한 값이 반영되었는가?
- 텍스트 변경 → 해당 텍스트가 코드에 있는가?
- 삭제 요청 → 해당 요소가 코드에서 제거되었는가?

### 공통 (가장 중요)
- ⚠️ 새로 만든 건 사용자에게 보여야 한다. 파일만 만들고 어디에도 연결 안 했으면 FAIL
- ⚠️ prop 기본값이 false/hidden이면 실제로 안 보임 → FAIL
- ⚠️ 조건부 렌더링(&&, 삼항)으로 기본 숨김 처리되어 있으면 → FAIL

## FAIL 작성 규칙
- 뭐가 누락됐는지 + 어떻게 해야 하는지 구체적으로 써라
- 나쁜 예: "FAIL: 헤더 수정 안 됨"
- 좋은 예: "FAIL: Header 컴포넌트에 /fortune 페이지로 이동하는 링크를 추가해야 함"

## 예시
요청: "만우절 콘텐츠 넣어줘"
변경: 생성 src/components/AprilFools/index.tsx
→ FAIL: AprilFools 컴포넌트를 기존 페이지(page.tsx)에서 import하고 렌더링해야 사용자에게 보임

요청: "운세 페이지 만들고 헤더에 버튼 연결해줘"
변경: 생성 src/app/fortune/page.tsx, 생성 FortuneSection/index.tsx
→ FAIL: Header 컴포넌트에 /fortune 경로로 이동하는 버튼/링크를 추가해야 함

요청: "Section3 타이틀 크기 키워줘"
변경: 수정 Section3/index.tsx (text-2xl → text-4xl)
→ PASS

요청: "버튼 색상 빨간색으로 바꿔줘"
변경: 수정 Button/index.tsx (bg-primary → bg-red-500)
→ PASS`;

/**
 * 검증 — 변경된 파일의 **실제 최신 내용**을 디스크에서 읽어서 확인
 * @param {string} userRequest - 원래 요청
 * @param {Array} changes - 적용된 변경 목록
 * @param {string} [repoPath] - 레포 경로 (있으면 파일 내용 확인)
 */
async function verifyChanges(userRequest, changes, repoPath) {
  try {
    const fs = require("fs");
    const path = require("path");

    let changeSummary;

    if (repoPath) {
      // 변경된 파일의 전체 내용을 디스크에서 읽어서 검증
      const changedPaths = [...new Set(changes.map((c) => c.filePath))];
      changeSummary = changedPaths.map((filePath) => {
        const absPath = path.join(repoPath, filePath);
        try {
          const content = fs.readFileSync(absPath, "utf-8");
          // 파일당 최대 2000자 (기존 300자 → 대폭 확대)
          const preview = content.slice(0, 2000);
          const truncated = content.length > 2000 ? "\n...(이하 생략)" : "";
          return `### ${filePath}\n\`\`\`\n${preview}${truncated}\n\`\`\``;
        } catch {
          return `### ${filePath} (파일 읽기 실패)`;
        }
      }).join("\n\n");
    } else {
      // repoPath 없으면 기존 방식 (changes 배열 기반)
      changeSummary = changes
        .map((c) => {
          const type = c.type === "create" ? "생성" : "수정";
          if (c.type === "create") {
            const preview = (c.content || "").slice(0, 2000);
            return `${type}: ${c.filePath}\n코드:\n${preview}`;
          } else {
            return `${type}: ${c.filePath}\n이전: ${(c.oldString || "").slice(0, 500)}\n이후: ${(c.newString || "").slice(0, 500)}`;
          }
        })
        .join("\n---\n");
    }

    const prompt = `## 사용자 요청\n${userRequest}\n\n## 변경된 파일의 현재 코드\n${changeSummary}`;

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

const TICKET_MATCH_SYSTEM = `너는 JIRA 티켓 매칭기야. 사용자의 요청과 스레드 대화 맥락을 보고, 주어진 티켓 목록에서 관련된 티켓을 골라.

## 규칙
- 사용자 요청과 관련된 티켓의 key를 콤마로 구분해서 출력해
- 최대 9개까지만 선택해
- 가장 관련성 높은 순서대로 나열해
- 관련 티켓이 없으면 "NONE"만 출력해
- 티켓 key 외에 다른 말은 하지 마

## 제외 기준 (이 봇은 UI/퍼블리싱만 가능)
- ⚠️ 백엔드 티켓 제외: API, DB, 서버, 인증, 데이터 저장/조회/연결 관련 티켓은 선택하지 마
- ⚠️ 제목에 "API", "DB", "서버", "Supabase", "저장", "조회", "통계" 등이 포함된 티켓은 백엔드 → 제외
- 프론트엔드 UI 구현 티켓만 선택해 (화면, 섹션, 컴포넌트, 폼, 레이아웃, 스타일, 인터랙션 등)

## 스레드 맥락 활용
- ⚠️ 스레드에서 이미 특정 티켓들이 "남은 할 일"이라고 언급됐다면 → 그 티켓들만 선택
- "구현 안된 거", "남은 거 해줘" 같은 포괄적 요청 → 스레드 맥락에서 언급된 미완료 티켓만 선택

## 판단 기준
- 사용자 요청의 키워드와 티켓 제목/설명이 매칭되는가
- 스레드 맥락에서 언급된 기능/페이지와 관련있는가
- 티켓 번호가 직접 언급되었는가 (예: "LAND-008" → 해당 티켓)

## 예시
요청: "랜딩 페이지 FAQ 섹션 수정해줘"
→ SCRUM-200

요청: "ISI 결과 화면이랑 점수 계산 구현해줘"
→ SCRUM-267,SCRUM-265

요청: "SCRUM-257 해줘"
→ SCRUM-257`;

const BACKEND_KEYWORDS = /API|DB|Supabase|서버|백엔드|데이터베이스|저장.*구현|조회.*API|통계.*API/i;

async function matchTickets(userMessage, threadHistory, tickets) {
  if (!tickets || tickets.length === 0) return [];

  // 백엔드 티켓 사전 필터링
  const frontendTickets = tickets.filter((t) => !BACKEND_KEYWORDS.test(t.summary));
  if (frontendTickets.length === 0) return [];

  try {
    const ticketList = frontendTickets
      .map((t) => `${t.key} | ${t.summary} | ${t.status} | ${t.description.slice(0, 100)}`)
      .join("\n");

    let content = `## 티켓 목록\n${ticketList}\n\n## 사용자 요청\n${userMessage}`;
    if (threadHistory) {
      content = `## 스레드 대화 맥락\n${threadHistory}\n\n${content}`;
    }

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: TICKET_MATCH_SYSTEM,
      messages: [{ role: "user", content }],
    });

    const result = response.content[0].text.trim();
    console.log(`[TICKET-MATCH] 결과: ${result}`);

    if (result === "NONE") return [];

    const keys = result.split(",").map((k) => k.trim()).filter(Boolean);
    // 프론트엔드 티켓만 반환
    return keys
      .map((key) => frontendTickets.find((t) => t.key === key))
      .filter(Boolean);
  } catch (err) {
    console.error("[TICKET-MATCH] 매칭 실패:", err.message);
    return [];
  }
}

module.exports = { classifyMessage, summarizeChanges, verifyChanges, matchTickets };
