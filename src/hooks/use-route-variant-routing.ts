"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RouteSegmentSnapshot,
  RouteVariantSnapshot,
  TransportMode,
} from "@/lib/room-contracts";
import type { Waypoint } from "@/lib/types";

type RouteMetrics = {
  distanceText: string | null;
  durationText: string | null;
  costText: string | null;
  polyline?: [number, number][];
};

const modeLabels: Record<TransportMode, string> = {
  walking: "步行",
  transit: "公交/地铁",
  driving: "驾车",
  bicycling: "骑行",
  
};

function formatDistance(value: unknown) {
  const meters = Number(value);
  if (!Number.isFinite(meters) || meters <= 0) return null;
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters)}m`;
}

function formatDuration(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h${rest}min` : `${hours}h`;
  }
  return `${minutes}min`;
}

function formatCost(value: unknown) {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return `¥${Math.round(cost)}`;
}

function parsePolyline(polyline?: string): [number, number][] {
  if (!polyline) return [];
  return polyline
    .split(";")
    .map((point) => {
      const [lng, lat] = point.split(",").map(Number);
      return Number.isFinite(lng) && Number.isFinite(lat)
        ? ([lng, lat] as [number, number])
        : null;
    })
    .filter((point): point is [number, number] => point !== null);
}

function collectPolylines(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPolylines(item));
  }

  const record = value as Record<string, unknown>;
  const ownPolyline = typeof record.polyline === "string" ? [record.polyline] : [];
  return [
    ...ownPolyline,
    ...Object.values(record).flatMap((item) => collectPolylines(item)),
  ];
}

function readNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function extractMetrics(data: unknown): RouteMetrics {
  const wrapper = data as { data?: { status?: string; info?: string; route?: { taxi_cost?: unknown; paths?: Array<Record<string, unknown>>; transits?: Array<Record<string, unknown>> } } };
  const amapData = wrapper.data;
  if (amapData?.status !== "1") {
    console.warn("[RouteVariant] AMap route error:", amapData?.info, "data keys:", amapData ? Object.keys(amapData) : "null");
    return { distanceText: null, durationText: null, costText: null };
  }
  const route = amapData?.route;
  const path = route?.paths?.[0] || route?.transits?.[0];
  if (!path) {
    console.warn("[RouteVariant] No path/transit found in route response. route keys:", route ? Object.keys(route) : "null");
    return { distanceText: null, durationText: null, costText: null };
  }

  const cost = path.cost as Record<string, unknown> | undefined;
  const polyline = collectPolylines(path).flatMap(parsePolyline);

  // AMap v5: duration is inside cost.duration, not path.duration
  const durationRaw = cost?.duration ?? path.duration;

  console.log("[RouteVariant] extracted metrics:", {
    distance: formatDistance(path.distance),
    duration: formatDuration(durationRaw),
    polylinePoints: polyline.length,
  });

  return {
    distanceText: formatDistance(path.distance),
    durationText: formatDuration(durationRaw),
    costText:
      formatCost(cost?.tolls) ||
      formatCost(cost?.taxi_cost) ||
      formatCost(route?.taxi_cost) ||
      formatCost(path.cost) ||
      null,
    polyline: polyline.length > 0 ? polyline : undefined,
  };
}

function locationString(location: [number, number]) {
  return `${location[0]},${location[1]}`;
}

async function fetchSegmentRoute(
  segment: RouteSegmentSnapshot,
  from: Waypoint,
  to: Waypoint,
  city: string,
): Promise<RouteSegmentSnapshot> {
  if (!from.location || !to.location) {
    console.warn("[RouteVariant] missing location:", segment.fromWaypointId, "->", segment.toWaypointId);
    return { ...segment, status: "failed" };
  }

  console.log("[RouteVariant] fetching route:", from.name, "->", to.name, "mode:", segment.mode, "city:", city);

  let response = await fetch("/api/amap/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      origin: locationString(from.location),
      destination: locationString(to.location),
      mode: segment.mode,
      city,
      city1: city,
      city2: city,
    }),
  });
  let data = await response.json().catch(() => null);

  console.log("[RouteVariant] route API response:", response.status, "configured:", data?.configured, "info:", data?.data?.info);

  // Fallback to driving when walking/bicycling exceeds AMap's range limit
  const outOfRange = (data?.data?.info || "").includes("OVER_DIRECTION_RANGE");
  if (outOfRange && (segment.mode === "walking" || segment.mode === "bicycling")) {
    console.log("[RouteVariant] falling back to driving due to range limit");
    const drivingResponse = await fetch("/api/amap/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: locationString(from.location),
        destination: locationString(to.location),
        mode: "driving",
        city,
        city1: city,
        city2: city,
      }),
    });
    const drivingData = await drivingResponse.json().catch(() => null);
    if (drivingResponse.ok && drivingData?.configured !== false) {
      response = drivingResponse;
      data = drivingData;
    }
  }

  if (!response.ok || data?.configured === false) {
    console.warn("[RouteVariant] route API failed:", response.status, data);
    return { ...segment, status: "failed" };
  }

  let metrics = extractMetrics(data);

  // Fallback to driving for any non-driving mode that returns no valid route
  // (e.g. cross-river transit where AMap has no feasible bus route)
  if (!metrics.distanceText && !metrics.durationText && segment.mode !== "driving") {
    console.log("[RouteVariant] falling back to driving due to empty metrics, mode:", segment.mode);
    const drivingResponse = await fetch("/api/amap/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: locationString(from.location),
        destination: locationString(to.location),
        mode: "driving",
        city,
        city1: city,
        city2: city,
      }),
    });
    const drivingData = await drivingResponse.json().catch(() => null);
    if (drivingResponse.ok && drivingData?.configured !== false) {
      metrics = extractMetrics(drivingData);
      // Preserve original mode in label but mark as ready with driving metrics
      return {
        ...segment,
        modeLabel: modeLabels[segment.mode],
        distanceText: metrics.distanceText,
        durationText: metrics.durationText,
        costText: metrics.costText,
        polyline: metrics.polyline,
        status: metrics.distanceText || metrics.durationText ? "ready" : "failed",
      };
    }
  }

  return {
    ...segment,
    modeLabel: modeLabels[segment.mode],
    distanceText: metrics.distanceText,
    durationText: metrics.durationText,
    costText: metrics.costText,
    polyline: metrics.polyline,
    status: metrics.distanceText || metrics.durationText ? "ready" : "failed",
  };
}

function sumSegmentNumber(
  segments: RouteSegmentSnapshot[],
  key: "distanceText" | "durationText" | "costText",
) {
  return segments.reduce((total, segment) => {
    const text = segment[key];
    if (!text) return total;
    if (text.includes("km")) return total + Number(text.replace("km", "")) * 1000;
    if (text.includes("min")) {
      if (text.includes("h")) {
        const [hoursPart, minutesPart] = text.split("h");
        return total + Number(hoursPart) * 60 + Number(minutesPart?.replace("min", "") || 0);
      }
      return total + Number(text.replace("min", ""));
    }
    if (text.includes("m")) return total + Number(text.replace("m", ""));
    if (text.includes("¥")) return total + Number(text.replace("¥", ""));
    return total;
  }, 0);
}

function summarizeVariant(variant: RouteVariantSnapshot): RouteVariantSnapshot {
  const readySegments = variant.segments.filter((segment) => segment.status === "ready");
  const distance = sumSegmentNumber(readySegments, "distanceText");
  const duration = sumSegmentNumber(readySegments, "durationText");
  const cost = sumSegmentNumber(readySegments, "costText");

  return {
    ...variant,
    totalDistanceText: distance > 0 ? formatDistance(distance) : variant.totalDistanceText,
    totalDurationText: duration > 0 ? formatDuration(duration * 60) : variant.totalDurationText,
    totalCostText: cost > 0 ? formatCost(cost) : variant.totalCostText,
    routeStatus:
      readySegments.length === variant.segments.length
        ? "ready"
        : readySegments.length > 0
          ? "partial"
          : "failed",
  };
}

export function useRouteVariantRouting(
  variant: RouteVariantSnapshot | null | undefined,
  resolvedWaypoints: Waypoint[],
  city: string,
) {
  const [routedVariant, setRoutedVariant] = useState<RouteVariantSnapshot | null>(
    variant || null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const resolvedKey = useMemo(
    () =>
      resolvedWaypoints
        .map((waypoint) => `${waypoint.id}:${waypoint.location?.join(",") || ""}`)
        .join("|"),
    [resolvedWaypoints],
  );

  const cacheRef = useRef<{ variantId: string; resolvedKey: string; city: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!variant) {
      setRoutedVariant(null);
      cacheRef.current = null;
      return;
    }

    // Skip if waypoints haven't changed — avoids re-requesting routes on every room poll
    if (
      cacheRef.current &&
      cacheRef.current.variantId === variant.id &&
      cacheRef.current.resolvedKey === resolvedKey &&
      cacheRef.current.city === city
    ) {
      return;
    }

    const currentVariant: RouteVariantSnapshot = variant;

    async function fetchSegmentRouteBatch(
      segments: RouteSegmentSnapshot[],
      waypointById: Map<string, Waypoint>,
      city: string,
    ): Promise<RouteSegmentSnapshot[]> {
      const results: RouteSegmentSnapshot[] = [];
      for (let i = 0; i < segments.length; i += 3) {
        const batch = segments.slice(i, i + 3);
        const batchResults = await Promise.all(
          batch.map((segment) => {
            const from = waypointById.get(segment.fromWaypointId);
            const to = waypointById.get(segment.toWaypointId);
            if (!from || !to) return Promise.resolve(segment);
            return fetchSegmentRoute(segment, from, to, city).catch(() => ({
              ...segment,
              status: "failed" as const,
            }));
          }),
        );
        results.push(...batchResults);
      }
      return results;
    }

    async function resolveRoutes() {
      setIsLoading(true);
      const waypointById = new Map(resolvedWaypoints.map((waypoint) => [waypoint.id, waypoint]));
      const nextSegments = await fetchSegmentRouteBatch(
        currentVariant.segments,
        waypointById,
        city,
      );

      if (!cancelled) {
        const updatedVariant: RouteVariantSnapshot = { ...currentVariant, segments: nextSegments as RouteSegmentSnapshot[] };
        setRoutedVariant(summarizeVariant(updatedVariant));
        setIsLoading(false);
        cacheRef.current = { variantId: currentVariant.id, resolvedKey, city };
      }
    }

    void resolveRoutes();

    return () => {
      cancelled = true;
    };
  }, [city, resolvedKey, variant]);

  return {
    variant: routedVariant,
    isLoading,
  };
}
