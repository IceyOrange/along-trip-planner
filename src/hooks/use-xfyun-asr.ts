"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type XfyunASRStatus =
  | "idle"
  | "connecting"
  | "recording"
  | "finalizing"
  | "completed"
  | "error";

type XfyunResultData = {
  cn?: {
    st?: {
      type?: string;
      rt?: Array<{
        ws?: Array<{
          cw?: Array<{ w?: string }>;
        }>;
      }>;
    };
  };
};

function parseResultData(dataStr: string): string {
  try {
    const parsed = JSON.parse(dataStr) as XfyunResultData;
    const rt = parsed.cn?.st?.rt;
    if (!Array.isArray(rt)) return "";
    return rt
      .flatMap((r) => r.ws || [])
      .flatMap((w) => w.cw || [])
      .map((c) => c.w || "")
      .join("");
  } catch {
    return "";
  }
}

function downsampleBuffer(
  buffer: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, buffer.length - 1);
    const frac = pos - left;
    result[i] = buffer[left] * (1 - frac) + buffer[right] * frac;
  }
  return result;
}

function computeRMS(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, s, true); // little-endian
  }
  return buffer;
}

export function useXfyunRealtimeASR() {
  const [status, setStatus] = useState<XfyunASRStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const interimRef = useRef("");
  const transcriptRef = useRef("");
  const statusRef = useRef<XfyunASRStatus>("idle");
  const lowVolumeStartRef = useRef<number | null>(null);
  const lowVolumeWarnedRef = useRef(false);

  // Keep refs in sync with state for use in closures
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const cleanupAudio = useCallback(() => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        /* ignore */
      }
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        /* ignore */
      }
      sourceRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      try {
        void audioCtxRef.current.close();
      } catch {
        /* ignore */
      }
    }
    audioCtxRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const cleanupWebSocket = useCallback(() => {
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const clear = useCallback(() => {
    cleanupAudio();
    cleanupWebSocket();
    setStatus("idle");
    setTranscript("");
    setInterimText("");
    setError(null);
    interimRef.current = "";
    transcriptRef.current = "";
    lowVolumeStartRef.current = null;
    lowVolumeWarnedRef.current = false;
  }, [cleanupAudio, cleanupWebSocket]);

  const stop = useCallback(() => {
    if (statusRef.current === "idle" || statusRef.current === "error") {
      return;
    }

    // Send end marker as text frame (not binary) per iFlytek protocol
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ end: true }));
      } catch (err) {
        console.warn("[XfyunASR] failed to send end marker:", err);
      }
    }

    cleanupAudio();

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setStatus("finalizing");
    } else {
      setStatus("completed");
    }
  }, [cleanupAudio]);

  const start = useCallback(async () => {
    if (
      statusRef.current === "connecting" ||
      statusRef.current === "recording" ||
      statusRef.current === "finalizing"
    ) {
      return;
    }

    clear();
    setStatus("connecting");
    setError(null);

    let preWarmedStream: MediaStream | null = null;

    try {
      // 1. Fetch signed WebSocket URL AND request mic in parallel
      const [res, stream] = await Promise.all([
        fetch("/api/asr/xfyun-url"),
        navigator.mediaDevices.getUserMedia({ audio: true }),
      ]);
      preWarmedStream = stream;
      streamRef.current = stream;

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || "获取 ASR 连接地址失败");
      }
      const { url } = (await res.json()) as { url: string };
      if (!url) {
        throw new Error("ASR 连接地址为空");
      }

      // 2. Open WebSocket
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        // Wait for started message before beginning audio capture
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string) as Record<string, unknown>;
        } catch {
          console.warn("[XfyunASR] invalid JSON:", event.data);
          return;
        }

        const action = msg.action as string | undefined;

        if (action === "started") {
          setStatus("recording");
          if (preWarmedStream) {
            void beginAudioCapture(preWarmedStream);
          }
          return;
        }

        if (action === "error") {
          const errMsg =
            typeof msg.desc === "string"
              ? msg.desc
              : "科大讯飞 ASR 服务返回错误";
          // 37005 = idle timeout after recording ends; treat as normal completion
          if (errMsg.includes("37005") || errMsg.includes("idle timeout")) {
            setStatus("completed");
            cleanupAudio();
            return;
          }
          setError(errMsg);
          setStatus("error");
          cleanupAudio();
          return;
        }

        if (action === "result") {
          const dataStr = typeof msg.data === "string" ? msg.data : "";
          if (!dataStr) return;

          let parsedData: XfyunResultData;
          try {
            parsedData = JSON.parse(dataStr) as XfyunResultData;
          } catch {
            return;
          }

          const type = parsedData.cn?.st?.type;
          const text = parseResultData(dataStr);

          if (type === "1") {
            // Intermediate result
            interimRef.current = text;
            setInterimText(text);
          } else {
            // Final result (type === "0" or undefined)
            if (text) {
              transcriptRef.current += text;
              setTranscript(transcriptRef.current);
            }
            interimRef.current = "";
            setInterimText("");
          }
          return;
        }

        if (action === "completed") {
          setStatus("completed");
          cleanupAudio();
          return;
        }
      };

      ws.onerror = () => {
        setError("WebSocket 连接异常");
        setStatus("error");
        cleanupAudio();
      };

      ws.onclose = () => {
        if (
          statusRef.current === "recording" ||
          statusRef.current === "finalizing"
        ) {
          setStatus("completed");
        }
        cleanupAudio();
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "启动实时语音转写失败";
      setError(message);
      setStatus("error");
      cleanupAudio();
    }

    async function beginAudioCapture(stream: MediaStream) {
      try {
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        if (audioCtx.state === "suspended") {
          await audioCtx.resume();
        }
        audioCtxRef.current = audioCtx;

        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        // Note: ScriptProcessorNode is deprecated in favor of AudioWorkletNode.
        // We use it here for broader browser compatibility. Migration to AudioWorklet
        // would require a separate audio-worklet module and addModule() setup.
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (statusRef.current !== "recording") return;

          const inputBuffer = e.inputBuffer.getChannelData(0);

          // Volume check: warn if microphone input is too low
          const rms = computeRMS(inputBuffer);
          if (rms < 0.015) {
            if (!lowVolumeStartRef.current) {
              lowVolumeStartRef.current = Date.now();
            } else if (Date.now() - lowVolumeStartRef.current > 2500 && !lowVolumeWarnedRef.current) {
              setError("麦克风音量较低，请靠近麦克风说话");
              lowVolumeWarnedRef.current = true;
            }
          } else {
            lowVolumeStartRef.current = null;
            if (lowVolumeWarnedRef.current) {
              setError(null);
              lowVolumeWarnedRef.current = false;
            }
          }

          const inputRate = audioCtx.sampleRate;
          const downsampled = downsampleBuffer(inputBuffer, inputRate, 16000);
          const pcm = floatTo16BitPCM(downsampled);

          try {
            ws.send(pcm);
          } catch (sendErr) {
            console.warn("[XfyunASR] send audio failed:", sendErr);
          }
        };

        // Mute output to prevent echo / sidetone
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 0;
        source.connect(processor);
        processor.connect(gainNode);
        gainNode.connect(audioCtx.destination);
      } catch (audioErr) {
        const msg =
          audioErr instanceof DOMException
            ? audioErr.name === "NotAllowedError"
              ? "麦克风权限未开启"
              : audioErr.name === "NotFoundError"
                ? "未检测到可用麦克风"
                : "音频采集启动失败"
            : "音频采集启动失败";
        setError(msg);
        setStatus("error");
        cleanupAudio();
      }
    }
  }, [clear, cleanupAudio]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAudio();
      cleanupWebSocket();
    };
  }, [cleanupAudio, cleanupWebSocket]);

  return {
    status,
    transcript,
    interimText,
    error,
    isRecording: status === "recording" || status === "connecting",
    start,
    stop,
    clear,
  };
}
