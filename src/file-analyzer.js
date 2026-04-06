// ============================================
// 파일 트리 수집 + Haiku로 관련 파일 특정
// ============================================
const fs = require("fs");
const path = require("path");
const { callHaiku } = require("./claude");

const IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  ".storybook",
  "public",
]);

const TARGET_EXTENSIONS = new Set([
  ".tsx",
  ".ts",
  ".css",
  ".js",
  ".jsx",
  ".json",
]);

/**
 * 프로젝트 파일 트리를 재귀적으로 수집 (파일명만, 내용 X)
 */
function collectFileTree(dir, baseDir = dir) {
  const results = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...collectFileTree(fullPath, baseDir));
    } else if (TARGET_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(path.relative(baseDir, fullPath));
    }
  }

  return results;
}

const FILE_ANALYZER_SYSTEM = `너는 Next.js + TypeScript + Tailwind CSS 프로젝트의 파일 분석 도우미야.
디자이너 요청을 보고, 수정이 필요한 파일 경로를 특정해.

규칙:
- 확실하지 않으면 관련 있을 수 있는 파일도 포함시켜. 빠뜨리는 것보다 많이 잡는 게 낫다.
- globals.css, tailwind.config 같은 전역 스타일 파일도 필요하면 포함해.
- 레이아웃 변경이면 layout.tsx, page.tsx도 포함해.
- 반드시 JSON 배열만 출력해. 다른 텍스트 없이.
- 예시: ["src/components/Sections/Section3/index.tsx", "src/app/globals.css"]`;

/**
 * Haiku에게 디자이너 요청 + 파일 트리를 보내서 관련 파일 경로 리스트를 받음
 */
async function identifyRelevantFiles(request, fileTree, figmaContext) {
  let prompt = `디자이너 요청: "${request}"

프로젝트 파일 목록:
${fileTree.join("\n")}

이 요청을 처리하려면 어떤 파일을 읽어야 하는지 경로만 JSON 배열로 답해.`;

  if (figmaContext) {
    prompt += `\n\n피그마 디자인 분석 결과도 참고해:\n${JSON.stringify(figmaContext, null, 2)}`;
  }

  const result = await callHaiku(FILE_ANALYZER_SYSTEM, prompt);

  try {
    // JSON 배열 추출 (앞뒤 텍스트 있을 수 있음)
    const match = result.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("JSON 배열 없음");
    return JSON.parse(match[0]);
  } catch (err) {
    console.error("[FILE-ANALYZER] 파싱 실패, 폴백:", err.message);
    // 폴백: 모든 tsx 파일 반환
    return fileTree.filter((f) => f.endsWith(".tsx"));
  }
}

/**
 * 파일 경로 리스트를 받아서 실제 내용을 읽어 반환
 */
function readFiles(filePaths, repoPath) {
  const results = [];
  for (const filePath of filePaths) {
    const absPath = path.join(repoPath, filePath);
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      results.push({ path: filePath, content });
    } catch (err) {
      console.warn(`[FILE-ANALYZER] 파일 읽기 실패: ${filePath} — ${err.message}`);
    }
  }
  return results;
}

/**
 * 파일 선정 검증 — 요청에서 키워드를 추출하고, 선정된 파일에 해당 키워드 관련 파일이 포함됐는지 확인.
 * 누락 시 파일 트리에서 매칭되는 파일을 자동 추가.
 */
function validateFileSelection(request, selectedFiles, fileTree) {
  // UI 컴포넌트 키워드 매핑 (한/영)
  const KEYWORD_MAP = [
    { keywords: ["헤더", "header", "네비", "nav", "gnb"], pattern: /header|nav|gnb/i },
    { keywords: ["푸터", "footer"], pattern: /footer/i },
    { keywords: ["사이드바", "sidebar", "drawer"], pattern: /sidebar|drawer/i },
    { keywords: ["모달", "modal", "dialog", "팝업", "popup"], pattern: /modal|dialog|popup/i },
    { keywords: ["버튼", "button", "btn", "cta"], pattern: /button|btn|cta/i },
    { keywords: ["폼", "form", "입력", "input"], pattern: /form|input/i },
    { keywords: ["카드", "card"], pattern: /card/i },
    { keywords: ["탭", "tab"], pattern: /tab/i },
    { keywords: ["레이아웃", "layout"], pattern: /layout/i },
    { keywords: ["페이지", "page"], pattern: /page\.(tsx|ts|jsx|js)$/i },
  ];

  const requestLower = request.toLowerCase();
  const added = [];

  for (const { keywords, pattern } of KEYWORD_MAP) {
    // 요청에 키워드가 포함되어 있는지
    const mentioned = keywords.some((kw) => requestLower.includes(kw));
    if (!mentioned) continue;

    // 이미 선정된 파일에 해당 패턴이 있는지
    const alreadyIncluded = selectedFiles.some((f) => pattern.test(f));
    if (alreadyIncluded) continue;

    // 파일 트리에서 매칭되는 파일 찾기
    const candidates = fileTree.filter((f) => pattern.test(f));
    if (candidates.length > 0) {
      // 가장 관련성 높은 파일 추가 (index.tsx 우선, 최대 3개)
      const sorted = candidates.sort((a, b) => {
        const aIdx = a.includes("index.") ? -1 : 0;
        const bIdx = b.includes("index.") ? -1 : 0;
        return aIdx - bIdx;
      });
      const toAdd = sorted.slice(0, 3);
      added.push(...toAdd);
      console.log(`[FILE-ANALYZER] 검증: "${keywords[0]}" 관련 파일 자동 추가 → ${toAdd.join(", ")}`);
    }
  }

  if (added.length > 0) {
    return [...new Set([...selectedFiles, ...added])];
  }
  return selectedFiles;
}

module.exports = { collectFileTree, identifyRelevantFiles, readFiles, validateFileSelection };
