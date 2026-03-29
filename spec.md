# Design Bot v5 리팩토링 설계서

## 왜 바꾸는가

현재 v4는 Claude Code CLI를 spawn해서 모든 작업을 위임한다. 문제는 CLI가 파일 하나 읽을 때마다 도구 호출 왕복이 발생해서, 다크모드 같은 큰 작업에서 도구 호출이 50~70회 발생하고 3~7분이 걸린다. 10분 타임아웃에 아슬아슬하거나 초과한다.

v5는 Claude Code CLI 의존을 완전히 제거하고, Anthropic API를 직접 호출한다. 봇(Node.js)이 파일 읽기/쓰기, 빌드, git을 직접 처리하고, AI에게는 "수정된 코드를 텍스트로 달라"고만 요청한다. API 왕복이 2~3회로 줄어들어 같은 작업이 1~2분에 끝난다.

### 실제 로그 비교 (다크모드 구현 요청)

**v4 (현재)**:

```
find × 6회, ls × 3회, grep × 2회 → 파일 탐색만 11회 왕복
Read × 20회 (같은 파일 중복 읽기 포함) → 파일 읽기만 20회 왕복
Write × N회 → 파일 쓰기도 왕복
총 도구 호출: 50~70회, 소요 시간: 3~7분
```

**v5 (목표)**:

```
fs.readdirSync → 파일 목록 즉시 (0초)
Haiku API 1회 → 관련 파일 특정 (2초)
fs.readFileSync × 20 → 파일 내용 읽기 (0.1초)
Sonnet API 1~2회 → 수정안 반환 (20~30초)
fs.writeFile × 20 → 파일 쓰기 (0.1초)
pnpm build (30~60초)
총 API 호출: 2~3회, 소요 시간: 1~2분
```

---

## 핵심 아키텍처 변경

```
v4: 슬랙 → 봇 → Claude Code CLI (전부 위임)
v5: 슬랙 → 봇(오케스트레이터) → Anthropic API (코드 생성만 위임)
```

봇이 오케스트레이터 역할을 한다:

1. 파일 트리 수집 → 봇이 직접 (fs)
2. 관련 파일 특정 → Haiku API
3. 파일 읽기 → 봇이 직접 (fs)
4. 코드 수정안 생성 → Sonnet API (tool use)
5. 파일 쓰기 → 봇이 직접 (fs)
6. 빌드 검증 → 봇이 직접 (child_process)
7. git commit/push/PR → 봇이 직접 (child_process)
8. Vercel 프리뷰 확인 → 봇이 직접
9. 슬랙 응답 → 봇이 직접

---

## 구현할 모듈

### 1. `src/claude.js` (새로 만듦 — CLI spawn 완전 제거)

Anthropic SDK를 사용한 API 호출 래퍼.

```javascript
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Haiku 호출: 파일 특정용 (빠르고 저렴)
async function callHaiku(systemPrompt, userMessage) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].text;
}

// Sonnet 호출: 코드 수정용 (tool use 포함)
async function callSonnet(systemPrompt, userMessage, tools) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: tools,
  });
  return response;
}
```

**핵심**: `spawn("/opt/homebrew/bin/claude", ...)` 코드를 전부 제거하고 SDK 호출로 대체.

---

### 2. `src/file-analyzer.js` (새로 만듦)

프로젝트 파일 트리 수집 + Haiku로 관련 파일 특정.

```javascript
// 1. 파일 트리 수집 (fs.readdirSync, 재귀)
function collectFileTree(dir, extensions = [".tsx", ".ts", ".css", ".js"]) {
  // node_modules, .git, .next 등 제외
  // 파일 경로만 리스트로 반환 (내용 X)
  // 예: ["src/components/Sections/Section1/index.tsx", ...]
}

// 2. Haiku에게 관련 파일 특정 요청
async function identifyRelevantFiles(request, fileTree) {
  const prompt = `
    디자이너 요청: "${request}"
    프로젝트 파일 목록:
    ${fileTree.join("\n")}
    
    이 요청을 처리하려면 어떤 파일을 읽어야 하는지 경로만 JSON 배열로 답해.
    확실하지 않으면 관련 있을 수 있는 파일도 포함해. 빠뜨리는 것보다 많이 잡는 게 낫다.
    반드시 JSON 배열만 출력해. 다른 텍스트 없이.
  `;
  const result = await callHaiku(HAIKU_SYSTEM_PROMPT, prompt);
  return JSON.parse(result); // ["src/components/...", ...]
}
```

**Haiku 시스템 프롬프트**: "너는 Next.js + Tailwind 프로젝트의 파일 분석 도우미다. 디자이너 요청을 보고 수정이 필요한 파일 경로를 특정해. 확실하지 않으면 포함시켜."

---

### 3. `src/code-generator.js` (새로 만듦)

Sonnet API에 요청 + 파일 내용을 보내서 수정안을 받는다. tool use 방식으로 응답.

```javascript
const TOOLS = [
  {
    name: "edit_file",
    description:
      "기존 파일의 특정 부분을 수정한다. old_string을 new_string으로 교체.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "수정할 파일의 절대 경로" },
        old_string: {
          type: "string",
          description: "교체할 기존 코드 (정확히 일치해야 함)",
        },
        new_string: { type: "string", description: "교체할 새 코드" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "create_file",
    description: "새 파일을 생성한다.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "생성할 파일의 절대 경로" },
        content: { type: "string", description: "파일 전체 내용" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "read_file",
    description:
      "추가로 읽어야 할 파일이 있을 때 사용. 처음 제공된 파일 외에 더 필요한 경우에만.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "읽을 파일의 절대 경로" },
      },
      required: ["file_path"],
    },
  },
];

async function generateCodeChanges(request, fileContents, figmaData, context) {
  // fileContents: [{ path: "src/...", content: "..." }, ...]
  // figmaData: 피그마 분석 결과 (있으면)
  // context: 이전 수정 이력 등

  const userMessage = buildUserMessage(
    request,
    fileContents,
    figmaData,
    context,
  );
  const response = await callSonnet(WIZKEY_SYSTEM_PROMPT, userMessage, TOOLS);

  // tool_use 응답 파싱
  return parseToolCalls(response);
}

// Sonnet이 read_file을 요청한 경우 → 해당 파일 읽어서 다시 전달 (멀티턴)
async function handleWithReadbacks(request, fileContents, figmaData, context) {
  let response = await generateCodeChanges(
    request,
    fileContents,
    figmaData,
    context,
  );
  let iterations = 0;
  const MAX_READBACKS = 5;

  while (response.hasReadRequests && iterations < MAX_READBACKS) {
    // read_file 요청된 파일을 읽어서 fileContents에 추가
    for (const readReq of response.readRequests) {
      const content = fs.readFileSync(readReq.file_path, "utf-8");
      fileContents.push({ path: readReq.file_path, content });
    }
    // 추가된 파일 포함해서 다시 호출
    response = await generateCodeChanges(
      request,
      fileContents,
      figmaData,
      context,
    );
    iterations++;
  }

  return response.changes; // [{ type: "edit"|"create", filePath, ... }]
}
```

**중요**: Sonnet이 처음 받은 파일 외에 더 필요하면 `read_file` 도구로 요청 → 봇이 읽어서 다시 전달. 이 멀티턴은 최대 5회로 제한.

---

### 4. `src/builder.js` (새로 만듦)

수정안 적용 + 빌드 검증.

```javascript
// 수정안을 실제 파일에 적용
async function applyChanges(changes) {
  for (const change of changes) {
    if (change.type === "create") {
      // 디렉토리 생성 후 파일 쓰기
      await fs.promises.mkdir(path.dirname(change.filePath), {
        recursive: true,
      });
      await fs.promises.writeFile(change.filePath, change.content);
    } else if (change.type === "edit") {
      const current = await fs.promises.readFile(change.filePath, "utf-8");
      const updated = current.replace(change.oldString, change.newString);
      if (current === updated) {
        console.warn(`[BUILDER] old_string not found in ${change.filePath}`);
      }
      await fs.promises.writeFile(change.filePath, updated);
    }
  }
}

// 빌드 실행
async function runBuild(repoPath) {
  const { stdout, stderr } = await execAsync("pnpm build", {
    cwd: repoPath,
    timeout: 120000,
  });
  return { success: true, stdout, stderr };
}

// 변경사항 되돌리기
async function revertChanges(repoPath) {
  await execAsync("git checkout .", { cwd: repoPath });
}
```

---

### 5. `src/figma.js` (새로 만듦 — MCP 대체)

피그마 REST API 직접 호출. MCP 서버 의존 제거.

```javascript
const FIGMA_API_BASE = "https://api.figma.com/v1";

// 피그마 URL에서 fileKey, nodeId 추출
function parseFigmaUrl(url) {
  const match = url.match(
    /figma\.com\/(design|file)\/([^/]+)\/.*[?&]node-id=([^&]+)/,
  );
  if (!match) return null;
  return { fileKey: match[2], nodeId: match[3].replace("-", ":") };
}

// 피그마 노드 데이터 가져오기
async function getFigmaNodeData(fileKey, nodeId) {
  const response = await fetch(
    `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${nodeId}`,
    {
      headers: { "X-Figma-Token": config.figma.apiKey },
    },
  );
  const data = await response.json();
  return data;
}

// 디자인 데이터에서 레이아웃/스타일 정보 추출
function extractDesignSpecs(nodeData) {
  // 레이어 구조, 색상, 폰트, 간격, border-radius 등 추출
  // Sonnet에 전달할 수 있는 구조화된 형태로 반환
}
```

**핵심**: `.mcp.json`과 `figma-developer-mcp` 패키지 의존이 완전히 사라진다. fetch로 직접 호출.

---

### 6. `src/handler.js` (전면 수정 — 오케스트레이터)

기존의 `runClaudeCode(prompt)` 한 방 호출을 단계별 오케스트레이션으로 교체.

```javascript
async function handleCodeRequest(message, repoPath, context) {
  // 1단계: 피그마 링크 감지 & 데이터 가져오기
  let figmaData = null;
  if (containsFigmaLink(message)) {
    const { fileKey, nodeId } = parseFigmaUrl(message);
    figmaData = await getFigmaNodeData(fileKey, nodeId);
  }

  // 2단계: 파일 트리 수집 (fs, 즉시)
  const fileTree = collectFileTree(repoPath);

  // 3단계: Haiku로 관련 파일 특정 (2초)
  const relevantPaths = await identifyRelevantFiles(message, fileTree);

  // 4단계: 관련 파일 내용 읽기 (fs, 즉시)
  const fileContents = relevantPaths.map((p) => ({
    path: p,
    content: fs.readFileSync(path.join(repoPath, p), "utf-8"),
  }));

  // 5단계: Sonnet으로 수정안 생성 (핵심, 20~30초)
  // read_file 요청이 오면 자동으로 파일 읽어서 멀티턴
  const changes = await handleWithReadbacks(
    message,
    fileContents,
    figmaData,
    context,
  );

  // 6단계: 수정안 적용 (fs, 즉시)
  await applyChanges(changes);

  // 7단계: 빌드 검증 + 재시도 루프 (최대 3회)
  let buildResult;
  for (let attempt = 1; attempt <= 3; attempt++) {
    buildResult = await runBuild(repoPath);
    if (buildResult.success) break;

    if (attempt < 3) {
      // 빌드 에러를 Sonnet에 보내서 수정 요청
      const fixes = await generateCodeChanges(
        `빌드 에러를 수정해줘: ${buildResult.stderr}`,
        fileContents, // 현재 파일 내용
        null,
        null,
      );
      await applyChanges(fixes);
    }
  }

  if (!buildResult.success) {
    await revertChanges(repoPath);
    return { status: "build_failed", error: buildResult.stderr };
  }

  // 8단계: git commit + push (기존 git.js 사용)
  // 9단계: Vercel 프리뷰 확인 (기존 vercel.js 사용)
  // 10단계: 결과 반환

  return { status: "ok", changes, buildResult };
}
```

---

### 7. `wizkey-prompt.js` (수정 — API용 시스템 프롬프트로 전환)

CLI용 지시사항(Read/Edit/Write 도구, git 명령어, 빌드 실행 등)을 제거하고, **코딩 컨벤션과 수정 판단 기준만** 남긴다.

#### 제거할 내용:

- "코드를 직접 Read → Edit/Write 도구로 수정해" → 봇이 도구를 정의해서 줌
- "pnpm build", "git commit", "git push" 관련 지시 → 봇이 직접 처리
- "/commit 스킬", "/pr 스킬" 관련 지시 → 봇이 직접 처리
- 파일 탐색 전략 (grep/find) → Haiku가 처리
- 수정 후 보고 형식 → 봇이 생성

#### 유지할 내용:

- 프로젝트 컨텍스트 (SleepThera, Next.js + TypeScript + Tailwind)
- 디렉토리 구조
- 코딩 컨벤션 (레이아웃, 색상, 스토리북, SVG)
- 모호한 요청 해석 규칙 (디자이너 표현 → 개발 해석)
- 피그마 구현 규칙 (피그마 값 그대로 사용, 색상 변환 등)
- "질문하지 마", "패키지 설치하지 마", "설정 파일 수정하지 마" 규칙

#### 추가할 내용:

- tool use 응답 지침: "edit_file과 create_file 도구를 사용해서 수정안을 반환해. 텍스트 설명이 아니라 도구 호출로 답해."
- "추가로 파일이 필요하면 read_file 도구를 사용해."
- "UI/퍼블리싱만 해. 백엔드 로직, API route, 인증 같은 기능은 구현하지 마."

---

## 변경 없는 모듈

| 모듈                | 역할                    | 비고                                    |
| ------------------- | ----------------------- | --------------------------------------- |
| `src/git.js`        | commit, push, PR 생성   | 그대로 사용                             |
| `src/vercel.js`     | Vercel 프리뷰 URL 확인  | 그대로 사용                             |
| `src/config.js`     | 환경변수 관리           | `@anthropic-ai/sdk` 관련 설정 추가 정도 |
| `src/messages.js`   | 슬랙 메시지 포맷팅      | 그대로 사용                             |
| `src/classifier.js` | 메시지 분류 (code/chat) | 이것도 API 직접 호출로 전환             |

---

## tool use 스키마 (Sonnet에 전달할 도구 정의)

```json
[
  {
    "name": "edit_file",
    "description": "기존 파일의 특정 부분을 수정한다. old_string은 파일에서 정확히 일치하는 부분이어야 한다.",
    "input_schema": {
      "type": "object",
      "properties": {
        "file_path": { "type": "string", "description": "수정할 파일 경로" },
        "old_string": {
          "type": "string",
          "description": "교체할 기존 코드 (정확히 일치)"
        },
        "new_string": { "type": "string", "description": "교체할 새 코드" }
      },
      "required": ["file_path", "old_string", "new_string"]
    }
  },
  {
    "name": "create_file",
    "description": "새 파일을 생성한다. 기존 파일이 있으면 덮어쓴다.",
    "input_schema": {
      "type": "object",
      "properties": {
        "file_path": { "type": "string", "description": "생성할 파일 경로" },
        "content": { "type": "string", "description": "파일 전체 내용" }
      },
      "required": ["file_path", "content"]
    }
  },
  {
    "name": "read_file",
    "description": "추가로 읽어야 할 파일 요청. 처음 제공된 파일 외에 더 필요한 경우에만 사용.",
    "input_schema": {
      "type": "object",
      "properties": {
        "file_path": { "type": "string", "description": "읽을 파일 경로" }
      },
      "required": ["file_path"]
    }
  }
]
```

---

## 설치 필요

```bash
npm install @anthropic-ai/sdk
```

기존의 Claude Code CLI (`@anthropic-ai/claude-code`)는 제거해도 됨.

---

## Dockerfile 변경

Claude Code CLI 설치 라인 제거:

```dockerfile
# 삭제: RUN npm install -g @anthropic-ai/claude-code
```

`@anthropic-ai/sdk`는 `package.json`의 dependencies에 추가되므로 `npm install`로 자동 설치됨.

---

## 주의사항

1. **기존 슬랙 이벤트 핸들러(app_mention, message)는 그대로 유지**. 자연어 소통, 스레드=브랜치 매핑, 큐잉 등은 변경 없음.

2. **기존 메시지 분류(code/chat/unclear)는 그대로 유지**. chat 타입 응답도 API 직접 호출로 전환.

3. **피그마 링크 감지는 기존 로직 유지**. MCP 대신 figma.js의 REST API 호출로 변경.

4. **슬랙 응답 포맷은 디자이너 친화적으로 변경**:
   - 파일 경로, 커밋 해시, 브랜치 이름 등 개발 용어 최소화
   - "뭐가 바뀌었는지" + "프리뷰 링크"만 간결하게

5. **read_file 멀티턴은 최대 5회로 제한**. 무한 루프 방지.

6. **빌드 재시도는 최대 3회**. 3회 실패 시 git checkout으로 원복.

7. **Sonnet 호출 시 max_tokens를 넉넉하게 설정 (16384)**. 파일 20개 수정이면 출력이 길어질 수 있음.

8. **UI/퍼블리싱만 처리**. 백엔드 로직, API route, 인증, DB 등은 구현하지 않도록 시스템 프롬프트에 명시.

---

## 리뷰에서 발견된 버그 3건 (반드시 반영)

### 버그 1: Vercel 폴링 — `since` 파라미터가 잘못됨

**현재 코드 (`src/vercel.js`)**:
```javascript
const pushTime = Date.now() - 30000; // 폴링 시작 시점 기준
```

**문제**: Claude Code가 7분 걸린 뒤 push하면, `pushTime`은 **폴링 시작 7분 전**으로 잡힌다.
Vercel 배포는 push 직후에 생성되는데, `since`가 너무 과거라 이미 끝난 옛 배포를 잡거나 아직 생성 안 된 배포를 못 잡을 수 있다.

**수정**: `waitForVercelDeployment`에 `pushTimestamp`를 외부에서 주입. handler에서 `git push` 완료 직후의 `Date.now()`를 전달.

```javascript
async function waitForVercelDeployment(branchName, pushTimestamp, maxWait = 180000) {
  const since = pushTimestamp - 30000; // push 시점 기준 30초 여유
  // ...
}
```

### 버그 2: 멀티턴에서 대화 컨텍스트가 날아감

**spec 원래 코드**:
```javascript
// 매번 새 대화 시작 — Sonnet이 이전에 뭘 했는지 모름
response = await generateCodeChanges(request, fileContents, ...);
```

**문제**: read_file 요청 후 다시 호출하면, Sonnet은 이전 턴에서 어떤 edit_file을 이미 반환했는지 모른다.
같은 파일을 중복 수정하거나 충돌하는 수정안을 낼 수 있다.

**수정**: Anthropic API의 멀티턴은 `messages` 배열에 이전 assistant 응답 + tool_result를 누적해야 한다.

```javascript
// 올바른 방식: 대화 이어가기
messages.push({ role: "assistant", content: response.content });
messages.push({ role: "user", content: [
  { type: "tool_result", tool_use_id: "xxx", content: "파일 내용..." }
]});
response = await client.messages.create({ messages, ... });
```

### 버그 3: `String.replace`가 매칭 실패해도 조용히 넘어감

**spec 원래 코드**:
```javascript
const updated = current.replace(change.oldString, change.newString);
// old_string이 파일에 없으면 → current === updated → 에러 없이 저장
```

**문제**: 수정이 안 됐는데 "수정 완료!"로 응답 → 디자이너가 프리뷰에서 변경을 확인할 수 없음.

**수정**: 매칭 실패 시 에러를 던져서 빌드 재시도 루프에서 Sonnet에게 알려준다.

```javascript
function applyEdit(filePath, oldString, newString) {
  const current = fs.readFileSync(filePath, "utf-8");
  if (!current.includes(oldString)) {
    throw new Error(`[EDIT 실패] old_string을 찾을 수 없음: ${filePath}`);
  }
  const count = current.split(oldString).length - 1;
  if (count > 1) {
    throw new Error(`[EDIT 실패] old_string이 ${count}번 존재 — 더 구체적인 old_string 필요: ${filePath}`);
  }
  return current.replace(oldString, newString);
}
```

---

## 작업 순서

1. `src/claude.js` 구현 (SDK 래퍼)
2. `src/file-analyzer.js` 구현 (파일 트리 + Haiku)
3. `src/figma.js` 구현 (REST API)
4. `src/code-generator.js` 구현 (Sonnet + tool use + read_file 멀티턴)
5. `src/builder.js` 구현 (파일 적용 + 빌드)
6. `wizkey-prompt.js` 수정 (API용으로 전환)
7. `src/handler.js` 수정 (오케스트레이터)
8. `bot.js` (또는 `index.js`) 수정 (CLI spawn 제거, 새 모듈 연결)
9. `Dockerfile` 수정 (Claude Code CLI 제거)
10. `package.json` 수정 (`@anthropic-ai/sdk` 추가)
11. 로컬 Docker 테스트
12. EC2 재배포
