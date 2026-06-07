"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Mic,
  Square,
  Route,
  Compass,
  Sparkles,
  MapPin,
  CloudSun,
  Clock3,
  Flag,
  ChevronDown,
  Type,
  AlertTriangle,
  Keyboard,
  X,
  Trash2,
  GripVertical,
} from "lucide-react";
import { useXfyunRealtimeASR } from "@/hooks/use-xfyun-asr";
import { useWaypointResolver } from "@/hooks/use-amap-data";
import { useRouteVariantRouting } from "@/hooks/use-route-variant-routing";
import { MapCanvas } from "@/components/map-canvas";
import type { RouteVariantSnapshot } from "@/lib/room-contracts";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TranscriptEntry = {
  id: string;
  time: string; // HH:MM
  text: string;
};

type AgentPlan = {
  summary?: string;
  routeDescription?: string;
  city?: string;
  routeVariants?: RouteVariantSnapshot[];
};

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

function formatTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const CITIES = ["珠海", "北京", "上海", "杭州", "厦门"];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TripRecorder() {
  const asr = useXfyunRealtimeASR();

  const [transcriptLog, setTranscriptLog] = useState<TranscriptEntry[]>([]);
  const [agentThinking, setAgentThinking] = useState(false);
  const [city, setCity] = useState("珠海");
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [selectedWpId, setSelectedWpId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mediaText, setMediaText] = useState("");
  const [showTextInput, setShowTextInput] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const autoPlanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTranscriptLenRef = useRef(0);

  /* -------------------- Notice helper -------------------- */

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? null : current));
    }, 2200);
  }, []);

  /* -------------------- Xfyun ASR completed handler -------------------- */

  useEffect(() => {
    if (asr.status === "completed" && asr.transcript.trim()) {
      const text = asr.transcript.trim();
      setTranscriptLog((prev) => [
        ...prev,
        {
          id: generateId(),
          time: formatTime(new Date()),
          text,
        },
      ]);
      showNotice("语音转写完成");

      // Clear auto-plan debounce timer
      if (autoPlanTimerRef.current) {
        clearTimeout(autoPlanTimerRef.current);
        autoPlanTimerRef.current = null;
      }

      // Defer requestPlan to avoid circular dependency / TDZ issues
      setTimeout(() => {
        void requestPlan(text);
      }, 0);
      asr.clear();
      lastTranscriptLenRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asr.status, asr.transcript]);

  /* -------------------- AI Planning -------------------- */

  const requestPlan = useCallback(async (extraText?: string) => {
    const logText = transcriptLog.map((t) => t.text).join("\n");
    const allText = logText + (extraText ? "\n" + extraText : "");
    if (allText.trim().length < 3) return;

    console.log("[TripRecorder] requesting plan with text:", allText.trim().slice(0, 200));
    showNotice("AI 正在规划行程…");
    setAgentThinking(true);
    try {
      const response = await fetch("/api/ai/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "route",
          city,
          recentTurns: [
            {
              id: "turn-" + Date.now(),
              userId: "user",
              userName: "讨论",
              text: allText.trim(),
              createdAt: Date.now(),
            },
          ],
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        configured?: boolean;
        plan?: AgentPlan;
        error?: string;
      };
      console.log("[TripRecorder] plan response:", response.status, data);
      if (response.ok && data.plan) {
        setPlan(data.plan);
        if (data.plan.city && typeof data.plan.city === "string") {
          setCity(data.plan.city);
        }
      } else if (data.configured === false) {
        showNotice("AI API 未配置");
      } else if (data.error) {
        showNotice(`规划失败: ${data.error}`);
        console.warn("[TripRecorder] plan API error:", data.error);
      } else {
        showNotice("规划未返回有效结果，请尝试输入更多旅行意向");
        console.warn("[TripRecorder] plan API returned no plan:", data);
      }
    } catch (err) {
      console.warn("[TripRecorder] plan failed:", err);
      showNotice("AI 规划服务异常，稍后重试");
    } finally {
      setAgentThinking(false);
    }
  }, [transcriptLog, city, showNotice]);

  /* -------------------- Auto-trigger planning while recording -------------------- */

  useEffect(() => {
    if (asr.status !== "recording" || !asr.transcript.trim() || agentThinking) return;

    const currentLen = asr.transcript.length;
    if (currentLen <= lastTranscriptLenRef.current) return;

    if (autoPlanTimerRef.current) {
      clearTimeout(autoPlanTimerRef.current);
    }

    autoPlanTimerRef.current = setTimeout(() => {
      if (agentThinking) return;
      lastTranscriptLenRef.current = asr.transcript.length;
      void requestPlan(asr.transcript);
    }, 3000);
  }, [asr.transcript, asr.status, agentThinking, requestPlan]);

  useEffect(() => {
    return () => {
      if (autoPlanTimerRef.current) {
        clearTimeout(autoPlanTimerRef.current);
      }
    };
  }, []);

  const submitMediaText = useCallback(() => {
    const text = mediaText.trim();
    if (!text) return;
    setTranscriptLog((prev) => [
      ...prev,
      {
        id: generateId(),
        time: formatTime(new Date()),
        text,
      },
    ]);
    setMediaText("");
    setShowTextInput(false);
    void requestPlan(text);
  }, [mediaText, requestPlan]);

  /* -------------------- Recording control -------------------- */

  const toggleRecording = useCallback(() => {
    if (asr.status === "recording" || asr.status === "connecting") {
      asr.stop();
    } else if (asr.status === "finalizing") {
      // Wait for final results; do nothing
    } else if (asr.status === "completed" || asr.status === "error") {
      asr.clear();
    } else {
      asr.start();
    }
  }, [asr]);

  /* -------------------- Clear log -------------------- */

  const clearLog = useCallback(() => {
    setTranscriptLog([]);
    setPlan(null);
    setSelectedWpId(null);
    setMediaText("");
    setShowTextInput(false);
    asr.clear();
    lastTranscriptLenRef.current = 0;
    showNotice("已清空记录");
  }, [asr, showNotice]);

  /* -------------------- Add waypoint from map -------------------- */

  const handleAddWaypoint = useCallback((newWp: { id: string; name: string; location: [number, number]; address?: string }) => {
    setPlan((prev) => {
      if (!prev || !prev.routeVariants?.[0]) {
        return {
          routeVariants: [{
            id: "manual",
            name: "自定义路线",
            label: "",
            theme: "",
            description: "",
            transportSummary: null,
            waypoints: [{
              id: newWp.id,
              name: newWp.name,
              order: 0,
              description: newWp.address,
              resolveStatus: "ready" as const,
              recommendedTransport: "walking" as const,
              address: newWp.address,
              location: newWp.location,
            }],
            segments: [],
            totalDistanceText: null,
            totalDurationText: null,
            totalCostText: null,
            routeStatus: "pending" as const,
          }],
        } as AgentPlan;
      }
      const variant = prev.routeVariants[0];
      const maxOrder = Math.max(...variant.waypoints.map((w) => w.order), -1);
      return {
        ...prev,
        routeVariants: [{
          ...variant,
          waypoints: [...variant.waypoints, {
            id: newWp.id,
            name: newWp.name,
            order: maxOrder + 1,
            description: newWp.address,
            resolveStatus: "ready" as const,
            recommendedTransport: "walking" as const,
            address: newWp.address,
            location: newWp.location,
          }],
        }],
      };
    });
    showNotice(`已添加 ${newWp.name}`);
  }, [showNotice]);

  /* -------------------- Waypoint resolution -------------------- */

  const planWaypoints = plan?.routeVariants?.[0]?.waypoints || [];
  const waypointInputs = planWaypoints.map((wp) => ({
    id: wp.id,
    name: wp.name,
    order: wp.order,
  }));
  const waypointResolver = useWaypointResolver(
    waypointInputs,
    city,
    plan?.routeVariants?.[0]?.id,
  );
  const resolvedWaypoints = waypointResolver.waypoints;

  /* -------------------- Route calculation -------------------- */

  const routedVariantState = useRouteVariantRouting(
    plan?.routeVariants?.[0] || null,
    resolvedWaypoints,
    city,
  );
  const routedVariant = routedVariantState.variant || plan?.routeVariants?.[0];
  const routePolylines =
    routedVariant?.segments
      ?.map((s) => s.polyline)
      .filter((polyline): polyline is [number, number][] => Boolean(polyline)) ||
    [];

  /* -------------------- Derived UI state -------------------- */

  const hasRoute = Boolean(routedVariant && routedVariant.waypoints.length > 0);
  const sortedWaypoints =
    routedVariant?.waypoints?.slice().sort((a, b) => a.order - b.order) || [];

  /* -------------------- Delete waypoint -------------------- */

  const handleDeleteWaypoint = useCallback(
    (wpId: string) => {
      setPlan((prev) => {
        if (!prev || !prev.routeVariants?.[0]) return prev;
        const variant = prev.routeVariants[0];
        const filteredWaypoints = variant.waypoints.filter((w) => w.id !== wpId);
        const reorderedWaypoints = filteredWaypoints.map((w, i) => ({
          ...w,
          order: i,
        }));
        return {
          ...prev,
          routeVariants: [
            {
              ...variant,
              waypoints: reorderedWaypoints,
            },
          ],
        };
      });
      if (selectedWpId === wpId) setSelectedWpId(null);
      showNotice("已删除地点");
    },
    [selectedWpId, showNotice]
  );

  /* -------------------- Drag & drop reorder -------------------- */

  const handleDragStart = useCallback((e: React.DragEvent, wpId: string) => {
    setDraggingId(wpId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", wpId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetWpId: string) => {
      e.preventDefault();
      const sourceId = e.dataTransfer.getData("text/plain");
      setDraggingId(null);
      if (!sourceId || sourceId === targetWpId) return;

      setPlan((prev) => {
        if (!prev || !prev.routeVariants?.[0]) return prev;
        const variant = prev.routeVariants[0];
        const waypoints = variant.waypoints.slice();
        const sourceIndex = waypoints.findIndex((w) => w.id === sourceId);
        const targetIndex = waypoints.findIndex((w) => w.id === targetWpId);
        if (sourceIndex === -1 || targetIndex === -1) return prev;

        const [moved] = waypoints.splice(sourceIndex, 1);
        waypoints.splice(targetIndex, 0, moved);
        const reordered = waypoints.map((w, i) => ({ ...w, order: i }));
        return {
          ...prev,
          routeVariants: [
            {
              ...variant,
              waypoints: reordered,
            },
          ],
        };
      });
      showNotice("已调整顺序");
    },
    [showNotice]
  );

  /* -------------------- Render -------------------- */

  return (
    <main className="workspace-page">
      {/* ===== Header ===== */}
      <header className="workspace-header">
        <div className="workspace-brand-area">
          <span className="brand-word">
            Along <small>同路</small>
          </span>
        </div>

        <div className="workspace-header-center">
          <span className="live-collaboration">
            <span className={`ai-indicator ${agentThinking ? "is-thinking" : ""}`} />
            {agentThinking ? "AI 规划中" : "准备就绪"}
          </span>
        </div>

        <div className="workspace-header-actions">
          <div className="city-selector">
            <MapPin size={14} />
            <select
              value={city}
              onChange={(e) => setCity(e.target.value)}
              aria-label="选择城市"
            >
              {CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </div>
        </div>
      </header>

      {/* ===== Body ===== */}
      <div className="workspace-body">
        {/* ---- Map ---- */}
        <div className="map-workspace">
          <div className="map-toolbar">
            <div className="location-context">
              <span>
                <MapPin size={16} />
              </span>
              <div>
                <small>当前目的地</small>
                <strong>{city}</strong>
              </div>
            </div>
            <div className="weather-pill">
              <CloudSun size={17} />
              <span>{waypointResolver.weatherText || "获取天气中…"}</span>
            </div>
          </div>
          <MapCanvas
            waypoints={resolvedWaypoints}
            routePolylines={routePolylines}
            selectedWaypointId={selectedWpId}
            onSelectWaypoint={(wpId) => setSelectedWpId(wpId)}
            onNotify={showNotice}
            onAddWaypoint={handleAddWaypoint}
          />

          {/* ===== Floating Recorder ===== */}
          <div className="floating-recorder">
            {/* Transcript card */}
            {(asr.status === "recording" || asr.status === "connecting" || asr.transcript || asr.interimText || asr.status === "error") && (
              <div className="floating-transcript-card">
                <div className="floating-transcript-header">
                  <span className={`floating-recorder-dot ${asr.status === "recording" || asr.status === "connecting" ? "is-recording" : ""}`} />
                  <span className="floating-transcript-status">
                    {asr.status === "connecting"
                      ? "连接中…"
                      : asr.status === "recording"
                        ? "正在实时转写…"
                        : asr.status === "error"
                          ? "转写出错"
                          : "转写完成"}
                  </span>
                </div>
                <div className="floating-transcript-body">
                  {asr.transcript && <p>{asr.transcript}</p>}
                  {asr.interimText && <p className="floating-transcript-interim">{asr.interimText}</p>}
                  {!asr.transcript && !asr.interimText && asr.status !== "error" && (
                    <p className="floating-transcript-placeholder">正在听…</p>
                  )}
                  {asr.error && <p className="floating-transcript-error">{asr.error}</p>}
                </div>
              </div>
            )}

            {/* Text input fallback */}
            {showTextInput && (
              <div className="floating-text-input-card">
                <div className="floating-text-input-header">
                  <span>文字输入</span>
                  <button
                    className="floating-text-input-close"
                    onClick={() => {
                      setShowTextInput(false);
                      setMediaText("");
                    }}
                    type="button"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="recorder-media-input">
                  <Type size={14} />
                  <input
                    type="text"
                    placeholder="输入讨论内容，按回车发送…"
                    value={mediaText}
                    onChange={(e) => setMediaText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitMediaText();
                    }}
                    autoFocus
                  />
                  <button onClick={submitMediaText} type="button">
                    <Sparkles size={14} />
                  </button>
                </div>
              </div>
            )}

            <div className="floating-recorder-controls">
              {/* Mic button */}
              <button
                className={`floating-recorder-btn ${asr.status === "recording" || asr.status === "connecting" ? "is-recording" : ""}`}
                onClick={toggleRecording}
                type="button"
                aria-label={
                  asr.status === "recording" || asr.status === "connecting"
                    ? "停止录音"
                    : asr.status === "completed" || asr.status === "error"
                      ? "重新录音"
                      : "开始录音"
                }
              >
                {asr.status === "recording" || asr.status === "connecting" ? (
                  <Square size={22} />
                ) : (
                  <Mic size={26} />
                )}
              </button>

              {/* Text input toggle */}
              {!showTextInput && (
                <button
                  className="floating-text-toggle"
                  onClick={() => setShowTextInput(true)}
                  type="button"
                  aria-label="文字输入"
                  title="文字输入"
                >
                  <Keyboard size={18} />
                </button>
              )}

              {/* Clear button */}
              {(plan || transcriptLog.length > 0) && (
                <button
                  className="floating-clear-btn"
                  onClick={clearLog}
                  type="button"
                  aria-label="清空"
                  title="清空记录"
                >
                  <Compass size={16} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ---- Right panel ---- */}
        <aside className="route-sidebar recorder-route-sidebar">
          <div className="map-route-panel-header">
            <Route size={16} />
            <strong>行程单</strong>
          </div>

          {hasRoute ? (
            <div className="map-route-details">
              <div className="map-route-metrics">
                <span>
                  <Clock3 size={13} /> {routedVariant?.totalDurationText || "--"}
                </span>
                <span>
                  <Route size={13} /> {routedVariant?.totalDistanceText || "--"}
                </span>
                <span>
                  <Flag size={13} /> {routedVariant?.totalCostText || "--"}
                </span>
              </div>

              {routedVariant?.routeStatus === "partial" && (
                <div className="map-route-partial-hint">
                  <AlertTriangle size={12} />
                  <span>部分路线无法规划，显示为直线连接</span>
                </div>
              )}

              <div className="map-route-segments">
                {sortedWaypoints.map((wp, idx) => {
                  const resolved = resolvedWaypoints.find((rw) => rw.id === wp.id);
                  const seg =
                    routedVariant?.segments?.[idx - 1];
                  return (
                    <div
                      key={wp.id}
                      className={`map-segment-item ${draggingId === wp.id ? "is-dragging" : ""}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, wp.id)}
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDrop(e, wp.id)}
                      onClick={() => setSelectedWpId(wp.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedWpId(wp.id);
                        }
                      }}
                    >
                      <div className="map-segment-drag-handle" title="拖动排序">
                        <GripVertical size={14} color="var(--ink-300)" />
                      </div>
                      <div className="map-segment-dot">
                        <b>{idx + 1}</b>
                        {idx < sortedWaypoints.length - 1 && <i />}
                      </div>
                      <div className="map-segment-info">
                        <strong>{wp.name}</strong>
                        <small>
                          {resolved?.resolveStatus === "ready"
                            ? resolved.address
                            : resolved?.resolveStatus === "not_found"
                              ? "未找到地址"
                              : "搜索中…"}
                        </small>
                        {seg && (
                          <span className="map-segment-route">
                            {seg.modeLabel}
                            {seg.durationText && " · " + seg.durationText}
                            {seg.distanceText && " · " + seg.distanceText}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="map-segment-delete"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteWaypoint(wp.id);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="map-route-empty">
              <Compass size={32} />
              <p>开始录音讨论旅行计划</p>
              <small>AI 会根据讨论内容自动规划路线</small>
            </div>
          )}
        </aside>
      </div>

      {/* ===== Toast ===== */}
      {notice && (
        <div className="workspace-toast" role="status">
          <Sparkles size={14} />
          {notice}
        </div>
      )}

      {/* ===== Styles ===== */}
      <style jsx>{`
        /* Override workspace layout: 2 columns instead of 3 */
        .workspace-page > :global(.workspace-body) {
          grid-template-columns: minmax(420px, 1fr) 320px;
        }
        .city-selector {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border: 1px solid var(--ink-200);
          border-radius: 10px;
          background: var(--white);
          color: var(--ink-700);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .city-selector select {
          appearance: none;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
          outline: none;
        }

        /* Floating recorder */
        .floating-recorder {
          position: absolute;
          bottom: 28px;
          left: 28px;
          z-index: 200;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 12px;
          max-width: 360px;
        }
        .floating-transcript-card {
          background: rgba(255, 255, 255, 0.96);
          border-radius: 16px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.06);
          padding: 14px 18px;
          backdrop-filter: blur(12px);
          border: 1px solid rgba(0, 0, 0, 0.04);
          min-width: 200px;
          max-width: 320px;
          animation: float-card-in 0.3s ease;
        }
        @keyframes float-card-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .floating-transcript-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .floating-recorder-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--ink-300);
          flex-shrink: 0;
        }
        .floating-recorder-dot.is-recording {
          background: #ef4444;
          animation: dot-pulse 1.2s ease-in-out infinite;
        }
        @keyframes dot-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        .floating-transcript-status {
          font-size: 11px;
          font-weight: 600;
          color: var(--ink-500);
        }
        .floating-transcript-body {
          font-size: 13px;
          line-height: 1.5;
          color: var(--ink-800);
          max-height: 120px;
          overflow-y: auto;
        }
        .floating-transcript-body p {
          margin: 0;
        }
        .floating-transcript-interim {
          color: var(--ink-400);
          font-style: italic;
        }
        .floating-transcript-placeholder {
          color: var(--ink-400);
        }
        .floating-transcript-error {
          color: #ef4444;
          font-size: 12px;
        }

        /* Text input card */
        .floating-text-input-card {
          background: rgba(255, 255, 255, 0.98);
          border-radius: 16px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
          padding: 12px 14px;
          backdrop-filter: blur(12px);
          border: 1px solid rgba(0, 0, 0, 0.06);
          min-width: 260px;
          animation: float-card-in 0.25s ease;
        }
        .floating-text-input-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: 12px;
          font-weight: 600;
          color: var(--ink-600);
        }
        .floating-text-input-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--ink-400);
          cursor: pointer;
        }
        .floating-text-input-close:hover {
          background: var(--ink-100);
          color: var(--ink-600);
        }

        /* Recorder controls row */
        .floating-recorder-controls {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .floating-recorder-btn {
          position: relative;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 200ms ease;
          border: 2px solid #ef4444;
          background: var(--white);
          color: #ef4444;
          box-shadow: 0 4px 16px rgba(239, 68, 68, 0.15);
        }
        .floating-recorder-btn:hover {
          transform: scale(1.08);
          box-shadow: 0 6px 24px rgba(239, 68, 68, 0.22);
        }
        .floating-recorder-btn.is-recording {
          background: #ef4444;
          color: white;
          border-color: #ef4444;
        }
        .floating-recorder-btn.is-recording::after {
          content: "";
          position: absolute;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          border: 2px solid #ef4444;
          animation: recorder-pulse 1.5s ease-out infinite;
        }
        @keyframes recorder-pulse {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.6); opacity: 0; }
        }
        .floating-text-toggle {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 150ms ease;
          border: 1px solid var(--ink-200);
          background: rgba(255, 255, 255, 0.95);
          color: var(--ink-600);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
        }
        .floating-text-toggle:hover {
          background: var(--white);
          transform: scale(1.05);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }
        .floating-clear-btn {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 150ms ease;
          border: 1px solid var(--ink-200);
          background: rgba(255, 255, 255, 0.95);
          color: var(--ink-500);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
        }
        .floating-clear-btn:hover {
          background: var(--white);
          color: #ef4444;
          transform: scale(1.05);
        }

        /* Shared input styles */
        .recorder-media-input {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border: 1px solid var(--ink-200);
          border-radius: 10px;
          background: var(--white);
        }
        .recorder-media-input input {
          flex: 1;
          border: 0;
          background: transparent;
          font-size: 13px;
          color: var(--ink-900);
          outline: none;
        }
        .recorder-media-input input::placeholder {
          color: var(--ink-500);
        }
        .recorder-media-input button {
          display: grid;
          width: 28px;
          height: 28px;
          place-items: center;
          border: 0;
          border-radius: 8px;
          background: var(--violet-100);
          color: var(--violet-700);
          cursor: pointer;
        }

        .map-route-partial-hint {
          display: flex;
          align-items: center;
          gap: 6px;
          margin: -6px 0 10px;
          padding: 6px 10px;
          border-radius: 8px;
          background: #fff8e6;
          color: #b38600;
          font-size: 11px;
          font-weight: 500;
        }

        .map-segment-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 10px;
          cursor: pointer;
          transition: background 150ms ease;
          position: relative;
        }
        .map-segment-item:hover {
          background: var(--ink-50);
        }
        .map-segment-item.is-dragging {
          opacity: 0.5;
        }
        .map-segment-drag-handle {
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: grab;
          padding: 2px;
          border-radius: 4px;
        }
        .map-segment-drag-handle:active {
          cursor: grabbing;
        }
        .map-segment-delete {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--ink-400);
          cursor: pointer;
          opacity: 0;
          transition: opacity 150ms ease, background 150ms ease, color 150ms ease;
        }
        .map-segment-item:hover .map-segment-delete {
          opacity: 1;
        }
        .map-segment-delete:hover {
          background: #fee2e2;
          color: #ef4444;
        }
      `}</style>
    </main>
  );
}
