import { NextResponse } from "next/server";
import { requestDeepSeekJson } from "@/lib/server/deepseek";
import { validateWaypoints } from "@/lib/server/poi-validator";
import type {
  ConversationTurnSnapshot,
  PlanningWaypointSnapshot,
  RouteVariantSnapshot,
  TransportMode,
} from "@/lib/room-contracts";

type PlanScope = "summary" | "route" | "compress";

type AgentPlan = {
  summary: string;
  routeDescription: string;
  city: string;
  waypoints: PlanningWaypointSnapshot[];
  routeVariants: RouteVariantSnapshot[];
};

type SummaryOutput = {
  summary: string;
  city: string;
  themes: string[];
};

type CompressOutput = {
  rollingSummary: string;
};

const transportModes: TransportMode[] = [
  "walking", "transit", "driving", "bicycling",
];

// ====== Helpers ======

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonObject(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(cleaned); } catch {
    const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(cleaned.slice(s, e + 1));
    throw new Error("模型没有返回 JSON 对象");
  }
}

function normalizeMode(value: unknown): TransportMode {
  const m = stringValue(value).toLowerCase();
  return transportModes.includes(m as TransportMode) ? (m as TransportMode) : "walking";
}

function normalizeWaypoints(raw: unknown, variantIndex = 0): PlanningWaypointSnapshot[] {
  return Array.isArray(raw) ? raw.map((item, i): PlanningWaypointSnapshot | null => {
    const r = asRecord(item); if (!r) return null;
    const name = stringValue(r.name); if (!name) return null;
    return {
      id: stringValue(r.id) || `v${variantIndex}-poi-${i}`,
      name, description: stringValue(r.description) || undefined,
      order: numberValue(r.order) ?? i,
      recommendedTransport: normalizeMode(r.recommendedTransport),
      resolveStatus: "pending",
    };
  }).filter((x): x is PlanningWaypointSnapshot => x !== null) : [];
}

function makeSegments(waypoints: PlanningWaypointSnapshot[]) {
  return waypoints.slice(0, -1).map((wp, i) => {
    const next = waypoints[i + 1];
    const mode = next.recommendedTransport || wp.recommendedTransport || "walking";
    return {
      id: `${wp.id}-${next.id}`, fromWaypointId: wp.id, toWaypointId: next.id,
      mode, modeLabel: modeLabel(mode),
      distanceText: null, durationText: null, costText: null, status: "pending" as const,
    };
  });
}

function modeLabel(m: TransportMode): string {
  return { walking: "步行", transit: "公交/地铁", driving: "驾车", bicycling: "骑行", electrobike: "电动车" }[m];
}

function dedupConversation(turns: ConversationTurnSnapshot[]): ConversationTurnSnapshot[] {
  const seen = new Set<string>();
  return turns.filter(t => {
    const key = t.userId + ":" + t.text.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function buildDiscussionText(rollingSummary: string | null, turns: ConversationTurnSnapshot[]): string {
  const deduped = dedupConversation(turns);
  const parts: string[] = [];
  if (rollingSummary) parts.push(`【历史讨论摘要】\n${rollingSummary}\n`);
  if (deduped.length > 0) {
    parts.push("【最近对话】");
    deduped.slice(-20).forEach(t => parts.push(`${t.userName}：${t.text}`));
  }
  return parts.join("\n");
}

// ====== Validators ======

function normalizeSummaryContent(content: string) {
  try {
    const r = asRecord(parseJsonObject(content));
    if (!r) return { ok: false as const, error: "不是 JSON 对象" };
    return {
      ok: true as const,
      value: {
        summary: stringValue(r.summary) || stringValue(r.requirementsSummary) || "AI 正在整理需求。",
        city: stringValue(r.city),
        themes: Array.isArray(r.themes) ? r.themes.map(v => stringValue(v)).filter(Boolean) : [],
      } satisfies SummaryOutput,
    };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "summary 解析失败" }; }
}

function normalizeCompressContent(content: string) {
  try {
    const r = asRecord(parseJsonObject(content));
    if (!r) return { ok: false as const, error: "不是 JSON 对象" };
    return { ok: true as const, value: { rollingSummary: stringValue(r.rollingSummary) || stringValue(r.summary) || "暂无讨论内容" } satisfies CompressOutput };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "compress 解析失败" }; }
}

function normalizeRouteContent(content: string) {
  try {
    const r = asRecord(parseJsonObject(content));
    if (!r) return { ok: false as const, error: "不是 JSON 对象" };
    const variants = Array.isArray(r.routeVariants) ? r.routeVariants.map((v, i) => {
      const vr = asRecord(v); if (!vr) return null;
      const waypoints = normalizeWaypoints(vr.waypoints, i);
      if (waypoints.length < 2) return null;
      return {
        id: stringValue(vr.id) || `variant-${i}`,
        name: stringValue(vr.name) || `方案${i + 1}`,
        label: stringValue(vr.label) || stringValue(vr.name) || "",
        theme: stringValue(vr.theme) || stringValue(vr.name) || "",
        description: stringValue(vr.description) || "",
        transportSummary: stringValue(vr.transportSummary) || null,
        waypoints,
        segments: makeSegments(waypoints),
        totalDistanceText: null, totalDurationText: null, totalCostText: null,
        routeStatus: "pending" as const,
      } as RouteVariantSnapshot;
    }).filter((x): x is RouteVariantSnapshot => x !== null) : [];

    if (variants.length === 0) return { ok: false as const, error: "模型未返回有效路线方案" };
    return {
      ok: true as const,
      value: {
        summary: stringValue(r.summary),
        routeDescription: stringValue(r.routeDescription),
        city: stringValue(r.city),
        waypoints: variants[0]?.waypoints || [],
        routeVariants: variants,
      } satisfies AgentPlan,
    };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "route 解析失败" }; }
}

// ====== Prompts (Chinese, hard constraints, negative examples, few-shot, dynamic themes) ======

const CORE_CONSTRAINTS = `
【核心要求】
1. 所有地点名必须是真实存在的中国 POI 名称，不确定就选你确定存在的替代品。不要用英文名，必须用中文名称（如"八达岭长城"而非"The Great Wall"）。
2. 不要编造不存在的 POI，不要使用过于冷门或无法在高德地图上搜索到的地点。
`;

function promptForScope(scope: PlanScope, city?: string, existingWaypoints?: PlanningWaypointSnapshot[]): string {
  if (scope === "compress") {
    return `你是旅行规划助手的对话压缩模块。将多轮对话压缩为一段不超过 200 字的摘要，保留关键决策、目的地和偏好分歧。
输出纯 JSON：{ "rollingSummary": "摘要文本" }`;
  }

  if (scope === "summary") {
    return `你是旅行规划助手的意图理解模块。分析用户的对话，提取共识和偏好。
${CORE_CONSTRAINTS}

【输出格式——纯 JSON】
{
  "summary": "用一段话概述用户的旅行需求、已确认的目的地、偏好和未解决的问题",
  "city": "用户讨论的目标城市名称",
  "themes": ["从对话中提取用户真正在意的 2-3 个维度，如'少走路'、'美食优先'、'文化深度'，不要硬编码"]
}

注意：summary 要准确反映对话内容，包括说话人归属（如"小明想去故宫，小红偏好轻松游"），不要编造对话中不存在的信息。`;

  }

  const existingCtx = existingWaypoints && existingWaypoints.length > 0
    ? `\n【以下地点已在当前行程中，供参考】\n${existingWaypoints.map((wp, i) => `${i + 1}. ${wp.name}${wp.description ? `（${wp.description}）` : ""}`).join("\n")}\n\n请根据用户新讨论的内容调整行程。如果用户明确说不想去某个地点，请从行程中移除该地点。如果用户新增地点，请补充到合适位置。`
    : "";

  return `你是旅行规划助手的路线规划模块。根据用户讨论自由理解意图，生成 1 条最优旅行路线。

请根据用户对话的上下文语义来理解：
- 用户提到想去哪里，就把相关地点加入行程
- 用户提到不想去或要删除哪里，就从行程中移除
- 注意用户的偏好（如轻松游、美食优先、少走路等），体现在路线设计中
- 不要机械匹配关键词，要理解上下文语义

${CORE_CONSTRAINTS}${existingCtx}

【输出格式——纯 JSON】
{
  "summary": "一段话概述最终路线方案的设计思路",
  "routeDescription": "一句话描述这条路线的特点",
  "city": "目标城市",
  "routeVariants": [
    {
      "id": "default",
      "name": "推荐路线",
      "description": "根据讨论生成的最优路线",
      "transportSummary": "整体交通建议",
      "waypoints": [
        { "id": "地点ID", "name": "真实POI名称", "description": "为什么选这里", "order": 0, "recommendedTransport": "walking" }
      ]
    }
  ]
}

routeVariants 必须恰好包含 1 个方案。waypoint 的 name 必须是真实可搜索的中文 POI 名称。
${city ? `当前目标城市是 ${city}，请围绕此城市规划。` : "请先从对话中推断城市。"}`;
}

function normalizeScope(value: unknown): PlanScope {
  const s = stringValue(value);
  if (s === "summary" || s === "route" || s === "compress") return s;
  return "route";
}

function normalizeTurns(value: unknown): ConversationTurnSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.map(t => {
    const r = asRecord(t); if (!r) return null;
    return {
      id: stringValue(r.id) || `turn-${Date.now()}-${Math.random()}`,
      userId: stringValue(r.userId) || "unknown",
      userName: stringValue(r.userName) || "用户",
      text: stringValue(r.text),
      createdAt: numberValue(r.createdAt) ?? Date.now(),
    } satisfies ConversationTurnSnapshot;
  }).filter((x): x is ConversationTurnSnapshot => x !== null);
}

// ====== POST Handler ======

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const scope = normalizeScope(body.scope);
  const recentTurns = normalizeTurns(body.recentTurns || body.conversation?.recentTurns || body.discussion);
  const rollingSummary = stringValue(body.rollingSummary || body.conversation?.rollingSummary);
  const city = stringValue(body.city);
  const existingWaypoints = normalizeWaypoints(body.existingWaypoints);
  console.log("[AI Plan] request received:", { scope, city, turnCount: recentTurns.length, existingCount: existingWaypoints.length });
  const discussionText = buildDiscussionText(rollingSummary, recentTurns);
  const messages = [
    { role: "system", content: promptForScope(scope, city, existingWaypoints) },
    { role: "user", content: `当前城市: ${city || "未知"}\n\n${discussionText}` },
  ];
  console.log("[AI Plan] messages built, calling DeepSeek");

  // --- compress ---
  if (scope === "compress") {
    const result = await requestDeepSeekJson<CompressOutput>(messages, {
      validateContent: normalizeCompressContent,
    });
    if (!result.configured) return NextResponse.json(result, { status: 501 });
    if (!result.ok) return NextResponse.json({ configured: true, scope, error: result.error || "压缩失败", attempts: result.attempts }, { status: 502 });
    if (!result.parsed) return NextResponse.json({ configured: true, scope, error: "压缩结果不完整" }, { status: 502 });
    return NextResponse.json({ configured: true, source: "deepseek", scope, model: result.model, attempts: result.attempts, rollingSummary: result.parsed.rollingSummary });
  }

  // --- summary ---
  if (scope === "summary") {
    const result = await requestDeepSeekJson<SummaryOutput>(messages, {
      validateContent: normalizeSummaryContent,
    });
    if (!result.configured) return NextResponse.json(result, { status: 501 });
    if (!result.ok) return NextResponse.json({ configured: true, scope, error: result.error || "摘要失败", attempts: result.attempts }, { status: 502 });
    if (!result.parsed) return NextResponse.json({ configured: true, scope, error: "摘要数据不完整" }, { status: 502 });
    return NextResponse.json({
      configured: true, source: "deepseek", scope, model: result.model, attempts: result.attempts,
      plan: { summary: result.parsed.summary, city: result.parsed.city || city, themes: result.parsed.themes },
    });
  }

  // --- route ---
  const result = await requestDeepSeekJson<AgentPlan>(messages, {
    validateContent: (content) => normalizeRouteContent(content),
  });
  console.log("[AI Plan] DeepSeek result:", { ok: result.ok, configured: result.configured, error: result.error, attempts: result.attempts?.length });
  if (!result.configured) return NextResponse.json(result, { status: 501 });
  if (!result.ok) return NextResponse.json({ configured: true, scope, error: result.error || "路线生成失败", attempts: result.attempts }, { status: 502 });
  if (!result.parsed) return NextResponse.json({ configured: true, scope, error: "路线数据不完整" }, { status: 502 });

  // POI validation ring
  const allWaypoints = result.parsed.routeVariants.flatMap(v => v.waypoints);
  const validated = await validateWaypoints(allWaypoints, result.parsed.city || city);
  console.log("[AI Plan] POI validation done:", validated.map(v => ({ name: v.name, status: v.resolveStatus, location: v.location })));

  // Merge validated coordinates back into variants
  const validatedVariants = result.parsed.routeVariants.map(variant => ({
    ...variant,
    waypoints: variant.waypoints.map(wp => {
      const v = validated.find(x => x.id === wp.id);
      return v ? { ...wp, ...v, name: v.name || wp.name } : wp;
    }),
  }));

  // Merge existing waypoints with AI-returned waypoints
  // - Match by normalized name to avoid duplicates
  // - Preserve existing waypoint id, location, address
  const normalized = (s: string) => s.replace(/[\s·]/g, "").toLowerCase();
  const mergedVariants = validatedVariants.map(variant => {
    const aiWps = variant.waypoints;
    const merged: PlanningWaypointSnapshot[] = [];

    for (const aiWp of aiWps) {
      const aiName = normalized(aiWp.name);
      const match = existingWaypoints.find(ew => normalized(ew.name) === aiName || ew.name.includes(aiWp.name) || aiWp.name.includes(ew.name));
      if (match) {
        merged.push({ ...aiWp, id: match.id, name: match.name, location: match.location, address: match.address, resolveStatus: match.resolveStatus });
      } else {
        merged.push(aiWp);
      }
    }

    // Re-order and rebuild segments
    const reordered = merged.map((wp, i) => ({ ...wp, order: i }));
    return {
      ...variant,
      waypoints: reordered,
      segments: makeSegments(reordered),
    };
  });

  console.log("[AI Plan] returning plan with variants:", mergedVariants.length, "waypoints:", mergedVariants[0]?.waypoints?.length);
  return NextResponse.json({
    configured: true, source: "deepseek", scope, model: result.model, attempts: result.attempts,
    plan: { ...result.parsed, routeVariants: mergedVariants },
  });
}
