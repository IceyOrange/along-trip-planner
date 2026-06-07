import { NextResponse } from "next/server";
import { requestDeepSeekJson } from "@/lib/server/deepseek";

export type PoiReviewData = {
  summary: string;
  reviewCount: number;
  tags: string[];
  tips?: string;
  rating?: number;
};

const REVIEW_SYSTEM_PROMPT = `你是一位资深旅行达人，熟悉中国各大城市的景点、餐厅和休闲场所。

用户会提供一个地点名称（可能还附带城市名），请根据你的知识为该地点生成一段简短的中文旅行点评。

要求：
1. summary: 1-2句话概括这个地点的特色和游玩体验，语气像真实游客写的点评
2. tags: 2-3个标签，如["必游景点", "拍照圣地", "亲子友好", "美食推荐", "夜景绝美"]
3. reviewCount: 模拟一个合理的评价数量，范围在 2000-80000 之间
4. tips: 一句实用的游玩建议（如最佳时间、交通提示、省钱技巧等）
5. rating: 一个 0-5 的评分，保留一位小数（如 4.2、4.7），反映该地点的综合口碑

请严格返回以下 JSON 格式，不要包含任何其他文字：
{
  "summary": "string",
  "reviewCount": number,
  "tags": ["string"],
  "tips": "string",
  "rating": number
}`;

function validateReviewContent(content: string) {
  try {
    const json = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
    if (typeof json.summary !== "string" || !json.summary) {
      return { ok: false as const, error: "缺少 summary" };
    }
    if (!Array.isArray(json.tags) || json.tags.length === 0) {
      return { ok: false as const, error: "缺少 tags" };
    }
    const reviewCount = typeof json.reviewCount === "number" ? json.reviewCount : 0;
    const rawRating = typeof json.rating === "number" ? json.rating : undefined;
    const rating = rawRating !== undefined ? Math.max(0, Math.min(5, Number(rawRating.toFixed(1)))) : undefined;
    return {
      ok: true as const,
      value: {
        summary: String(json.summary),
        reviewCount: Math.max(1000, Math.min(100_000, reviewCount)),
        tags: json.tags.filter((t: unknown) => typeof t === "string").slice(0, 4),
        tips: typeof json.tips === "string" ? json.tips : undefined,
        rating,
      } satisfies PoiReviewData,
    };
  } catch {
    return { ok: false as const, error: "JSON 解析失败" };
  }
}

export async function POST(request: Request) {
  let body: { name?: string; city?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "无效的 JSON 请求体" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "缺少 name 参数" }, { status: 400 });
  }

  const city = typeof body.city === "string" ? body.city.trim() : undefined;

  const userPrompt = city
    ? `请为「${city}」的「${name}」生成旅行点评。`
    : `请为「${name}」生成旅行点评。`;

  const result = await requestDeepSeekJson(
    [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    {
      validateContent: (content) => validateReviewContent(content),
    },
  );

  if (!result.configured) {
    return NextResponse.json(
      { error: "DeepSeek API 未配置", missing: result.missing },
      { status: 503 },
    );
  }

  if (!result.ok || !result.parsed) {
    return NextResponse.json(
      { error: result.error || "生成点评失败" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    review: result.parsed,
  });
}
