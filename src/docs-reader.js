// ============================================
// docs 레포에서 관련 스펙 읽기 + 구현 여부 판단
// ============================================
const fs = require("fs");
const path = require("path");
const { CONFIG } = require("./config");
const { callHaiku } = require("./claude");

/**
 * docs 레포의 핵심 문서 파일 목록
 * 우선순위 순서: 페이지별 스펙 > 개요 > PRD > 티켓
 */
const DOCS_FILES = [
  "docs/pages/landing.md",
  "docs/pages/test.md",
  "docs/pages/register.md",
  "docs/OVERVIEW.md",
  "PRD.md",
  "jira-tickets.md",
];

/**
 * docs 레포에서 모든 핵심 문서를 읽어 반환
 * @returns {{ path: string, content: string }[]}
 */
function readAllDocs() {
  const docsPath = CONFIG.docs.path;
  if (!docsPath || !fs.existsSync(docsPath)) return [];

  const results = [];
  for (const filePath of DOCS_FILES) {
    const absPath = path.join(docsPath, filePath);
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      results.push({ path: filePath, content });
    } catch {
      // 파일이 없으면 건너뜀
    }
  }
  return results;
}

const FIND_SPECS_SYSTEM = `너는 SleepThera 랜딩페이지 프로젝트의 스펙 분석 도우미야.
사용자 요청(또는 JIRA 티켓)을 보고, 관련된 스펙 섹션을 찾아서 반환해.

## 스펙 ID 체계
- LAND-001 ~ LAND-011: 랜딩페이지 요소
- TEST-001 ~ TEST-010: 테스트 페이지 요소
- REG-001 ~ REG-007: 등록 페이지 요소
- SCRUM-1 ~ SCRUM-36: JIRA 티켓

## 규칙
- 요청과 직접 관련된 스펙 ID를 모두 찾아
- 요청에 스펙 ID가 명시되어 있으면 그것 + 관련된 것도 포함
- 요청에 스펙 ID가 없으면 내용으로 판단해서 매칭
- 반드시 아래 JSON 형식으로만 출력해. 다른 텍스트 없이.

출력 형식:
{
  "specIds": ["LAND-002", "LAND-003"],
  "relevantFiles": ["docs/pages/landing.md"],
  "summary": "Hero 섹션과 Trust 섹션 관련 스펙"
}`;

/**
 * 요청/티켓 내용을 기반으로 관련 스펙을 찾는다
 * @param {string} message - 사용자 요청 또는 티켓 내용
 * @param {{ path: string, content: string }[]} docs - 읽은 문서들
 * @returns {{ specIds: string[], relevantFiles: string[], summary: string }}
 */
async function findRelevantSpecs(message, docs) {
  if (docs.length === 0) return { specIds: [], relevantFiles: [], summary: "" };

  // 토큰 절약: 개요 + 페이지 스펙만 먼저 보내서 관련 스펙 ID 특정
  const overviewDoc = docs.find((d) => d.path === "docs/OVERVIEW.md");
  const pagesDocs = docs.filter((d) => d.path.startsWith("docs/pages/"));
  const ticketsDoc = docs.find((d) => d.path === "jira-tickets.md");

  let docsContext = "";
  if (overviewDoc) docsContext += `## ${overviewDoc.path}\n${overviewDoc.content}\n\n`;
  for (const doc of pagesDocs) {
    docsContext += `## ${doc.path}\n${doc.content}\n\n`;
  }
  if (ticketsDoc) docsContext += `## ${ticketsDoc.path}\n${ticketsDoc.content.slice(0, 5000)}\n\n`;

  const prompt = `## 사용자 요청\n${message}\n\n## 프로젝트 문서\n${docsContext}`;

  try {
    const result = await callHaiku(FIND_SPECS_SYSTEM, prompt);
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("JSON 없음");
    return JSON.parse(match[0]);
  } catch (err) {
    console.error("[DOCS] 스펙 매칭 실패:", err.message);
    return { specIds: [], relevantFiles: [], summary: "" };
  }
}

/**
 * 찾은 스펙 ID에 해당하는 상세 내용만 추출
 * @param {string[]} specIds - 관련 스펙 ID 목록 (예: ["LAND-002", "TEST-009"])
 * @param {{ path: string, content: string }[]} docs - 읽은 문서들
 * @returns {string} 스펙 상세 내용
 */
function extractSpecContent(specIds, docs) {
  if (specIds.length === 0) return "";

  const sections = [];
  const pagesDocs = docs.filter((d) => d.path.startsWith("docs/pages/"));

  for (const doc of pagesDocs) {
    for (const specId of specIds) {
      // 스펙 ID가 포함된 섹션을 추출 (#### LAND-002 ~ 다음 #### 까지)
      const pattern = new RegExp(
        `(####?\\s+${specId.replace("-", "[-–]")}[\\s\\S]*?)(?=\\n####?\\s|\\n---\\n|$)`,
      );
      const match = doc.content.match(pattern);
      if (match) {
        sections.push(`[${doc.path}]\n${match[1].trim()}`);
      }
    }
  }

  // PRD에서 관련 섹션도 추출
  const prd = docs.find((d) => d.path === "PRD.md");
  if (prd) {
    for (const specId of specIds) {
      if (prd.content.includes(specId)) {
        const pattern = new RegExp(
          `(#{2,4}[^#]*${specId.replace("-", "[-–]")}[\\s\\S]*?)(?=\\n#{2,4}\\s|$)`,
        );
        const match = prd.content.match(pattern);
        if (match) sections.push(`[PRD.md]\n${match[1].trim()}`);
      }
    }
  }

  return sections.join("\n\n---\n\n");
}

const CHECK_IMPL_SYSTEM = `너는 코드 리뷰어야. 스펙 문서와 실제 코드를 비교해서 구현 상태를 판단해.

## 판단 기준
- "implemented": 스펙의 핵심 기능이 코드에 모두 구현됨
- "partial": 일부만 구현됨 (빠진 부분 명시)
- "not_implemented": 관련 코드가 거의 없음
- "unclear": 코드가 없거나 판단 불가

## 규칙
- 텍스트/카피 차이는 무시 (내용이 아닌 기능 구현 여부만 봐)
- CSS 스타일 차이는 무시 (레이아웃, 인터랙션 구현 여부만 봐)
- 반드시 아래 JSON 형식으로만 출력. 다른 텍스트 없이.

출력 형식:
{
  "status": "partial",
  "implemented": ["Hero 섹션 기본 레이아웃", "CTA 버튼"],
  "missing": ["신뢰 배지 미구현", "hover 인터랙션 없음"],
  "recommendation": "신뢰 배지 추가 및 hover 효과 구현 필요"
}`;

/**
 * 스펙 내용과 실제 코드를 비교해서 구현 상태를 판단
 * @param {string} specContent - 스펙 상세 내용
 * @param {{ path: string, content: string }[]} codeFiles - 관련 코드 파일들
 * @returns {{ status: string, implemented: string[], missing: string[], recommendation: string }}
 */
async function checkImplementation(specContent, codeFiles) {
  if (!specContent || codeFiles.length === 0) {
    return { status: "unclear", implemented: [], missing: [], recommendation: "" };
  }

  const codeContext = codeFiles
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``)
    .join("\n\n");

  const prompt = `## 스펙 문서\n${specContent}\n\n## 현재 코드\n${codeContext}`;

  try {
    const result = await callHaiku(CHECK_IMPL_SYSTEM, prompt);
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("JSON 없음");
    return JSON.parse(match[0]);
  } catch (err) {
    console.error("[DOCS] 구현 상태 확인 실패:", err.message);
    return { status: "unclear", implemented: [], missing: [], recommendation: "" };
  }
}

/**
 * 전체 docs 컨텍스트 생성 파이프라인
 * message + 티켓 정보를 받아서 → 관련 스펙 찾기 → 내용 추출 → 구현 여부 판단
 *
 * @param {string} message - 사용자 요청
 * @param {{ path: string, content: string }[]} codeFiles - 현재 관련 코드 파일
 * @returns {{ docsContext: string, implStatus: object, specIds: string[] } | null}
 */
async function buildDocsContext(message, codeFiles) {
  const docs = readAllDocs();
  if (docs.length === 0) {
    console.log("[DOCS] docs 문서 없음, 스킵");
    return null;
  }

  console.log("[DOCS] 관련 스펙 검색 중...");
  const { specIds, summary } = await findRelevantSpecs(message, docs);

  if (specIds.length === 0) {
    console.log("[DOCS] 관련 스펙 없음, 기존 방식으로 진행");
    return null;
  }

  console.log(`[DOCS] 관련 스펙: ${specIds.join(", ")} — ${summary}`);
  const specContent = extractSpecContent(specIds, docs);

  if (!specContent) {
    console.log("[DOCS] 스펙 내용 추출 실패");
    return null;
  }

  console.log("[DOCS] 구현 상태 확인 중...");
  const implStatus = await checkImplementation(specContent, codeFiles);
  console.log(`[DOCS] 구현 상태: ${implStatus.status}`);

  if (implStatus.status === "implemented") {
    console.log("[DOCS] 이미 완전히 구현됨");
  }

  // Sonnet에게 전달할 docs 컨텍스트 문자열 생성
  let docsContext = `## 프로젝트 스펙 문서\n관련 스펙: ${specIds.join(", ")}\n\n${specContent}`;

  if (implStatus.status === "partial") {
    docsContext += `\n\n## 구현 상태 분석\n- 상태: 부분 구현\n- 구현됨: ${implStatus.implemented.join(", ")}\n- 미구현: ${implStatus.missing.join(", ")}\n- 권장: ${implStatus.recommendation}`;
  } else if (implStatus.status === "not_implemented") {
    docsContext += `\n\n## 구현 상태 분석\n- 상태: 미구현\n- 권장: ${implStatus.recommendation}`;
  }

  return { docsContext, implStatus, specIds };
}

module.exports = {
  readAllDocs,
  findRelevantSpecs,
  extractSpecContent,
  checkImplementation,
  buildDocsContext,
};
