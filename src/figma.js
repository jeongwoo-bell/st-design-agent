// ============================================
// Figma REST API 직접 호출 (MCP 대체)
// ============================================
const { CONFIG } = require("./config");

const FIGMA_API_BASE = "https://api.figma.com/v1";

/**
 * 피그마 URL에서 fileKey, nodeId 추출
 */
function parseFigmaUrl(url) {
  const match = url.match(
    /figma\.com\/(design|file)\/([^/]+)\/.*[?&]node-id=([^&\s]+)/,
  );
  if (!match) return null;
  return {
    fileKey: match[2],
    nodeId: decodeURIComponent(match[3]).replace("-", ":"),
  };
}

/**
 * 메시지에서 피그마 URL들을 모두 추출
 */
function extractFigmaUrls(text) {
  const regex = /https?:\/\/[\w.]*figma\.com\/(design|file)\/[^\s>)]+/g;
  return text.match(regex) || [];
}

/**
 * 피그마 노드 데이터 가져오기
 */
async function getFigmaNodeData(fileKey, nodeId) {
  if (!CONFIG.figma.apiKey) {
    throw new Error("FIGMA_API_KEY 미설정");
  }

  const url = `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const response = await fetch(url, {
    headers: { "X-Figma-Token": CONFIG.figma.apiKey },
  });

  if (!response.ok) {
    throw new Error(`Figma API 에러: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * 노드 데이터에서 디자인 스펙 추출 (재귀적)
 */
function extractDesignSpecs(nodeData) {
  const specs = [];

  function walk(node, depth = 0) {
    const spec = {
      name: node.name,
      type: node.type,
    };

    // 레이아웃 정보
    if (node.absoluteBoundingBox) {
      spec.width = node.absoluteBoundingBox.width;
      spec.height = node.absoluteBoundingBox.height;
    }

    // Auto Layout
    if (node.layoutMode) {
      spec.layout = {
        mode: node.layoutMode, // HORIZONTAL | VERTICAL
        gap: node.itemSpacing,
        paddingTop: node.paddingTop,
        paddingRight: node.paddingRight,
        paddingBottom: node.paddingBottom,
        paddingLeft: node.paddingLeft,
        align: node.primaryAxisAlignItems,
        crossAlign: node.counterAxisAlignItems,
      };
    }

    // 폰트 스타일
    if (node.style) {
      spec.font = {
        family: node.style.fontFamily,
        size: node.style.fontSize,
        weight: node.style.fontWeight,
        lineHeight: node.style.lineHeightPx,
        letterSpacing: node.style.letterSpacing,
      };
    }

    // 색상 (fills)
    if (node.fills && node.fills.length > 0) {
      spec.fills = node.fills
        .filter((f) => f.type === "SOLID" && f.visible !== false)
        .map((f) => ({
          color: rgbaToHex(f.color, f.opacity),
          opacity: f.opacity,
        }));
    }

    // 테두리
    if (node.strokes && node.strokes.length > 0) {
      spec.strokes = node.strokes.map((s) => ({
        color: s.color ? rgbaToHex(s.color, s.opacity) : null,
        weight: node.strokeWeight,
      }));
    }

    // 모서리
    if (node.cornerRadius) {
      spec.borderRadius = node.cornerRadius;
    }

    // 텍스트 내용
    if (node.characters) {
      spec.text = node.characters;
    }

    // 이펙트 (그림자 등)
    if (node.effects && node.effects.length > 0) {
      spec.effects = node.effects
        .filter((e) => e.visible !== false)
        .map((e) => ({
          type: e.type,
          color: e.color ? rgbaToHex(e.color) : null,
          offset: e.offset,
          radius: e.radius,
          spread: e.spread,
        }));
    }

    specs.push(spec);

    // 자식 노드 재귀 탐색
    if (node.children) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  walk(nodeData);
  return specs;
}

/**
 * Figma RGBA (0~1) → hex 변환
 */
function rgbaToHex(color, opacity = 1) {
  if (!color) return null;
  const r = Math.round((color.r || 0) * 255);
  const g = Math.round((color.g || 0) * 255);
  const b = Math.round((color.b || 0) * 255);
  const a = Math.round((color.a ?? opacity ?? 1) * 255);
  if (a === 255) {
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
  }
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a.toString(16).padStart(2, "0")}`.toUpperCase();
}

/**
 * 메시지에서 피그마 링크를 감지하고 디자인 데이터를 가져옴
 * @returns {object|null} { specs, rawData } 또는 null
 */
async function fetchFigmaData(message) {
  const urls = extractFigmaUrls(message);
  if (urls.length === 0) return null;

  const allSpecs = [];

  for (const url of urls) {
    const parsed = parseFigmaUrl(url);
    if (!parsed) {
      console.warn(`[FIGMA] URL 파싱 실패: ${url}`);
      continue;
    }

    try {
      console.log(`[FIGMA] 데이터 가져오는 중: ${parsed.fileKey} / ${parsed.nodeId}`);
      const data = await getFigmaNodeData(parsed.fileKey, parsed.nodeId);
      const nodes = data.nodes || {};
      for (const nodeId of Object.keys(nodes)) {
        const node = nodes[nodeId]?.document;
        if (node) {
          const specs = extractDesignSpecs(node);
          allSpecs.push(...specs);
        }
      }
    } catch (err) {
      console.error(`[FIGMA] 데이터 가져오기 실패: ${err.message}`);
    }
  }

  if (allSpecs.length === 0) return null;
  return { specs: allSpecs };
}

module.exports = {
  parseFigmaUrl,
  extractFigmaUrls,
  getFigmaNodeData,
  extractDesignSpecs,
  fetchFigmaData,
};
