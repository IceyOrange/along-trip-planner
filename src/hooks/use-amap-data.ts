"use client";

import { useEffect, useRef, useState } from "react";
import type { Waypoint } from "@/lib/types";

type AmapSearchPoi = {
  id?: string;
  name?: string;
  type?: string;
  address?: string | string[];
  location?: string;
  adname?: string;
  photos?: Array<{ title?: string; url?: string }>;
  business?: {
    opentime_today?: string;
    opentime_week?: string;
    rating?: string;
    business_area?: string;
    cost?: string;
  };
};

type ResolveResult = {
  waypoints: Waypoint[];
  weatherText: string;
  isConfigured: boolean;
  isLoading: boolean;
  error: string | null;
};

function parseLocation(loc?: string): [number, number] | undefined {
  const [lng, lat] = (loc || "").split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : undefined;
}

async function searchWaypoint(
  name: string,
  id: string,
  order: number,
  city: string,
): Promise<Waypoint> {
  try {
    const res = await fetch(
      `/api/amap/search?keywords=${encodeURIComponent(name)}&region=${encodeURIComponent(city)}&page_size=1`,
      { cache: "no-store" },
    );
    const data = (await res.json()) as {
      configured?: boolean;
      data?: { pois?: AmapSearchPoi[] };
    };
    const poi = data?.data?.pois?.[0];
    if (poi) {
      const photos = poi.photos
        ?.filter(
          (photo): photo is { title?: string; url: string } =>
            typeof photo.url === "string" && photo.url.trim().length > 0,
        )
        .map((photo) => ({
          title: photo.title,
          url: photo.url.trim(),
        }));

      return {
        id,
        name: poi.name || name,
        description: undefined,
        order,
        resolveStatus: "ready",
        amapId: poi.id,
        address: Array.isArray(poi.address) ? poi.address.join("") : poi.address,
        location: parseLocation(poi.location),
        category: poi.type?.split(";")[0],
        photoUrl: photos?.[0]?.url,
        photos,
        rating: poi.business?.rating,
        businessHours: poi.business?.opentime_today || poi.business?.opentime_week,
        cost: poi.business?.cost,
      };
    }
  } catch {
    // fall through
  }
  return { id, name, order, resolveStatus: "not_found" };
}

export function useWaypointResolver(
  waypointInputs: Array<{ id: string; name: string; order: number }>,
  city: string,
  variantId?: string | null,
): ResolveResult {
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [weatherText, setWeatherText] = useState("");
  const [isConfigured, setIsConfigured] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use refs to avoid stale closure issues and infinite re-render loops
  const inputsRef = useRef(waypointInputs);
  const cityRef = useRef(city);
  const resolveIdRef = useRef(0);
  const weatherCacheRef = useRef<Record<string, string>>({});
  inputsRef.current = waypointInputs;
  cityRef.current = city;

  useEffect(() => {
    const inputs = waypointInputs;
    const targetCity = city;
    const currentResolveId = ++resolveIdRef.current;

    if (inputs.length === 0) {
      setWaypoints([]);
      setWeatherText("");
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const statusRes = await fetch("/api/amap/status", { cache: "no-store" });
        const status = (await statusRes.json()) as { webService?: { ready?: boolean } };
        if (cancelled || currentResolveId !== resolveIdRef.current) return;

        if (!status.webService?.ready) {
          setIsConfigured(false);
          setWaypoints(inputs.map((wp) => ({ ...wp, resolveStatus: "not_found" as const })));
          return;
        }

        setIsConfigured(true);
        const resolved: Waypoint[] = [];
        for (let i = 0; i < inputs.length; i += 3) {
          const batch = inputs.slice(i, i + 3);
          const batchResults = await Promise.all(
            batch.map((wp) => searchWaypoint(wp.name, wp.id, wp.order, targetCity)),
          );
          if (cancelled || currentResolveId !== resolveIdRef.current) return;
          resolved.push(...batchResults);
        }
        setWaypoints(resolved);

      } catch {
        if (!cancelled) setError("地图服务暂时不可用");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // Only re-resolve when the key or inputs length changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(waypointInputs) + "|" + city + "|" + (variantId || "")]);

  // Weather only depends on city — cache to avoid redundant fetches
  useEffect(() => {
    if (!city) {
      setWeatherText("");
      return;
    }
    const cached = weatherCacheRef.current[city];
    if (cached !== undefined) {
      setWeatherText(cached);
      return;
    }
    fetch(`/api/amap/weather?city=${encodeURIComponent(city)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { data?: { lives?: Array<{ weather?: string; temperature?: string }> } }) => {
        const live = data?.data?.lives?.[0];
        if (live) {
          const text = [live.weather, live.temperature ? live.temperature + "℃" : ""]
            .filter(Boolean)
            .join(" · ");
          weatherCacheRef.current[city] = text;
          setWeatherText(text);
        }
      })
      .catch(() => {
        // weather is optional
      });
  }, [city]);

  return { waypoints, weatherText, isConfigured, isLoading, error };
}
