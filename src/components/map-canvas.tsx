"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Layers3, Navigation2, Star, Clock, MapPin, X, Banknote, Loader2, AlertCircle, RefreshCw, Plus } from "lucide-react";
import type { Waypoint } from "@/lib/types";
import { getPoiReview } from "@/lib/poi-reviews";
import type { PoiReviewData } from "@/lib/poi-reviews";

type MapCanvasProps = {
  waypoints: Waypoint[];
  routePolylines?: [number, number][][];
  selectedWaypointId: string | null;
  onSelectWaypoint: (waypointId: string) => void;
  onNotify?: (message: string) => void;
  onAddWaypoint?: (waypoint: { id: string; name: string; location: [number, number]; address?: string }) => void;
};

const COLORS = ["#7167f6", "#ff8c65", "#24b59f", "#2d7ff9", "#e64980", "#fab005"];

function haversineDistance(a: [number, number], b: [number, number]): number {
  const R = 6371000; // meters
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `约 ${Math.round(meters)}m`;
  return `约 ${(meters / 1000).toFixed(1)}km`;
}

function ratingLabel(rating: number): string {
  if (rating >= 4.5) return "很好";
  if (rating >= 4.0) return "好";
  if (rating >= 3.0) return "一般";
  return "较差";
}

const TRAVEL_RELEVANT_KEYWORDS = [
  "风景", "旅游", "景点", "游览", "名胜", "古迹", "遗产",
  "公园", "植物园", "动物园", "主题乐园", "乐园", "度假区",
  "博物馆", "纪念馆", "展览馆", "美术馆", "图书馆", "文化",
  "寺庙", "教堂", " Mosque ", "道观", "宗祠",
  "古镇", "古城", "老街", "古街", "步行街", "胡同",
  "海滩", "海滨", "海岛", "沙滩", "海湾", "海岸",
  "山", "峰", "岭", "峡谷", "瀑布", "温泉", "湖", "湿地",
  "餐饮", "美食", "餐厅", "小吃", "酒楼", "饭店", "面馆", "火锅", "烧烤",
  "购物", "商场", "市集", "夜市", "商业街",
];

function isTravelRelevantPoi(poi: any): boolean {
  const type = poi.type || "";
  const name = poi.name || "";
  const text = `${type};${name}`;
  return TRAVEL_RELEVANT_KEYWORDS.some((kw) => text.includes(kw));
}

function formatReviewCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万条评价`;
  return `${n}条评价`;
}

function truncate(str: string, len: number): string {
  if (!str) return "";
  if (str.length <= len) return str;
  return str.slice(0, len) + "...";
}

function parsePoiLocation(poi: any): [number, number] | null {
  const loc = poi.location;
  if (typeof loc === "string") {
    const parts = loc.split(",");
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  } else if (Array.isArray(loc) && loc.length >= 2) {
    const lng = Number(loc[0]);
    const lat = Number(loc[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  } else if (loc && typeof loc === "object") {
    const lng = Number(loc.lng ?? loc.getLng?.() ?? loc.longitude);
    const lat = Number(loc.lat ?? loc.getLat?.() ?? loc.latitude);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  }
  return null;
}

export function MapCanvas({
  waypoints,
  routePolylines = [],
  selectedWaypointId,
  onSelectWaypoint,
  onNotify,
  onAddWaypoint,
}: MapCanvasProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const [mapMode, setMapMode] = useState<"map" | "satellite">("map");
  const [zoomLevel, setZoomLevel] = useState(13);
  const [realMapState, setRealMapState] = useState<"disabled" | "loading" | "ready" | "error">("disabled");
  const [selectedWp, setSelectedWp] = useState<Waypoint | null>(null);
  const [clickedPois, setClickedPois] = useState<any[]>([]);
  const [clickPosition, setClickPosition] = useState<[number, number] | null>(null);
  const [clickPixel, setClickPixel] = useState<{ x: number; y: number } | null>(null);
  const [mapContainerSize, setMapContainerSize] = useState({ width: 0, height: 0 });
  const [heroImageIndex, setHeroImageIndex] = useState(0);
  const [poiReviews, setPoiReviews] = useState<Map<string, PoiReviewData>>(new Map());
  const [selectedWpReview, setSelectedWpReview] = useState<PoiReviewData | null>(null);
  const geocoderRef = useRef<any>(null);

  const resolvedWaypoints = useMemo(
    () => waypoints.filter((wp) => wp.resolveStatus === "ready" && wp.location),
    [waypoints],
  );
  const routePath = useMemo(
    () => routePolylines.flat().filter((point) => point.length === 2),
    [routePolylines],
  );

  const onSelectWaypointRef = useRef(onSelectWaypoint);
  onSelectWaypointRef.current = onSelectWaypoint;
  const mapInstanceRef = useRef<any>(null);
  const amapApiRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  // Initialize real map once
  const mapInitRef = useRef(false);
  const polylinesRef = useRef<any[]>([]);

  const standardLayerRef = useRef<any>(null);
  const lastFitHashRef = useRef<string>("");
  const jsKey = process.env.NEXT_PUBLIC_AMAP_JS_KEY;
  const securityJsCode = process.env.NEXT_PUBLIC_AMAP_SECURITY_JS_CODE;
  const hasKey = Boolean(jsKey && jsKey.length > 0);

  // Reset gallery index when selected waypoint changes
  useEffect(() => {
    setHeroImageIndex(0);
  }, [selectedWp?.id]);

  // Async fetch AI review for selected waypoint
  useEffect(() => {
    if (!selectedWp || selectedWp.resolveStatus !== "ready") {
      setSelectedWpReview(null);
      return;
    }
    const name = selectedWp.name;
    let cancelled = false;
    async function load() {
      const review = await getPoiReview(name);
      if (!cancelled) setSelectedWpReview(review || null);
    }
    load();
    return () => { cancelled = true; };
  }, [selectedWp?.id, selectedWp?.name, selectedWp?.resolveStatus]);

  // Async fetch AI reviews for clicked POIs
  useEffect(() => {
    if (clickedPois.length === 0) {
      setPoiReviews(new Map());
      return;
    }
    let cancelled = false;
    async function load() {
      const map = new Map<string, PoiReviewData>();
      for (const poi of clickedPois) {
        const name = poi.name || "";
        if (!name) continue;
        const review = await getPoiReview(name);
        if (review) map.set(name, review);
      }
      if (!cancelled) setPoiReviews(map);
    }
    load();
    return () => { cancelled = true; };
  }, [clickedPois]);

  useEffect(() => {
    if (mapInitRef.current || !hasKey || !mapRef.current) return;
    mapInitRef.current = true;
    setRealMapState("disabled");

    async function initMap() {
      if (!mapRef.current) return;
      setRealMapState("loading");
      try {
        if (securityJsCode) {
          (window as typeof window & { _AMapSecurityConfig?: { securityJsCode: string } }
          )._AMapSecurityConfig = { securityJsCode };
        }
        const { load } = await import("@amap/amap-jsapi-loader");
        const AMap = await load({
          key: jsKey as string,
          version: "2.0",
          plugins: ["AMap.Scale", "AMap.ToolBar", "AMap.Geocoder"],
        });
        if (!mapRef.current) return;
        amapApiRef.current = AMap;
        const map = new AMap.Map(mapRef.current, {
          center: [113.576677, 22.270978],
          mapStyle: "amap://styles/normal",
          resizeEnable: true,
          viewMode: "3D",
          zoom: 13,
          features: ["bg", "road", "building", "point"],
          showBuildingBlock: true,
        });
        mapInstanceRef.current = map;
        map.addControl(new AMap.Scale());
        map.addControl(new AMap.ToolBar({
          position: { bottom: "84px", right: "18px" },
        }));

        const geocoder = new AMap.Geocoder({ radius: 1000, extensions: "all" });
        geocoderRef.current = geocoder;

        // Click on map blank area: close panels and search nearby POIs
        map.on("click", (e: any) => {
          const lnglat = e?.lnglat;
          const pixel = e?.pixel;
          if (!lnglat || !pixel) return;
          setClickedPois([]);
          setSelectedWp(null);
          setClickPixel({ x: pixel.x, y: pixel.y });
          if (mapRef.current) {
            const rect = mapRef.current.getBoundingClientRect();
            setMapContainerSize({ width: rect.width, height: rect.height });
          }
          if (geocoderRef.current) {
            geocoderRef.current.getAddress([lnglat.lng, lnglat.lat], (status: string, result: any) => {
              if (status === "complete" && result.regeocode) {
                const pois = (result.regeocode.pois || []).filter(isTravelRelevantPoi);
                setClickedPois(pois.slice(0, 3));
                setClickPosition([lnglat.lng, lnglat.lat]);
              }
            });
          }
        });

        setRealMapState("ready");
      } catch {
        setRealMapState("error");
      }
    }
    void initMap();
  }, [hasKey, jsKey, securityJsCode]);

  // Update markers/polyline when waypoints change
  useEffect(() => {
    const map = mapInstanceRef.current;
    const AMap = amapApiRef.current;
    if (!map || !AMap) return;
    markersRef.current.forEach((m: any) => { try { map.remove(m); } catch {} });
    markersRef.current = [];
    polylinesRef.current.forEach((p: any) => { try { map.remove(p); } catch {} });
    polylinesRef.current = [];
    if (resolvedWaypoints.length === 0) { lastFitHashRef.current = ""; return; }

    const markers: any[] = [];
    resolvedWaypoints.forEach((wp, index) => {
      const marker = new AMap.Marker({
        anchor: "bottom-center",
        content: `<div class="amap-custom-marker">${index + 1}</div>`,
        position: wp.location,
        title: wp.name,
      });
      marker.on("click", () => {
        onSelectWaypointRef.current(wp.id);
        setSelectedWp(wp);
      });
      map.add(marker);
      markers.push(marker);
      // Also bind DOM click for testing / programmatic access
      const markerDom = marker.getContentDom?.() || marker.getContent?.();
      if (markerDom instanceof HTMLElement) {
        markerDom.style.cursor = "pointer";
        markerDom.addEventListener("click", () => {
          onSelectWaypointRef.current(wp.id);
          setSelectedWp(wp);
        });
      }
    });
    markersRef.current = markers;

    const polylinePath =
      routePath.length >= 2
        ? routePath
        : resolvedWaypoints.map((wp) => wp.location).filter(Boolean);

    if (polylinePath.length >= 2) {
      const isSatellite = mapMode === "satellite";

      // Border layer (outline)
      const borderPolyline = new AMap.Polyline({
        path: polylinePath,
        strokeColor: isSatellite ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.9)",
        strokeWeight: 7,
        strokeOpacity: 0.9,
        lineJoin: "round",
        zIndex: 0,
      });

      // Glow layer (wider, softer)
      const glowPolyline = new AMap.Polyline({
        path: polylinePath,
        strokeColor: isSatellite ? "#FFD54F" : "#7167f6",
        strokeWeight: 12,
        strokeOpacity: 0.15,
        lineJoin: "round",
        zIndex: 1,
      });

      // Main layer
      const mainPolyline = new AMap.Polyline({
        path: polylinePath,
        strokeColor: isSatellite ? "#FFD54F" : "#7167f6",
        strokeWeight: 5,
        strokeOpacity: isSatellite ? 0.8 : 0.6,
        lineJoin: "round",
        showDir: true,
        zIndex: 2,
      });

      map.add([borderPolyline, glowPolyline, mainPolyline]);
      polylinesRef.current = [borderPolyline, glowPolyline, mainPolyline];

      // Fit view to show all waypoints
      const locationHash = resolvedWaypoints
        .map(wp => wp.location ? `${wp.location[0].toFixed(4)},${wp.location[1].toFixed(4)}` : "")
        .join("|");
      if (locationHash !== lastFitHashRef.current && polylinePath.length >= 2) {
        lastFitHashRef.current = locationHash;
        map.setFitView(
          [...markers, glowPolyline, mainPolyline, borderPolyline],
          false,
          [60, 60, 120, 60],
        );
      }
    }
  }, [resolvedWaypoints, routePath, mapMode]);

  const changeMode = (mode: "map" | "satellite") => {
    setMapMode(mode);
    const map = mapInstanceRef.current;
    const AMap = amapApiRef.current;
    if (!map || !AMap) return;

    if (mode === "satellite") {
      map.setLayers([new AMap.TileLayer.Satellite()]);
    } else {
      if (!standardLayerRef.current) {
        standardLayerRef.current = new AMap.TileLayer({ lang: 'zh_cn' });
      }
      map.setLayers([standardLayerRef.current]);
      map.setMapStyle("amap://styles/normal");
      map.setFeatures(["bg", "road", "building", "point"]);
    }
  };

  const updateZoom = (zoom: number) => {
    const z = Math.max(3, Math.min(20, zoom));
    setZoomLevel(z);
    const map = mapInstanceRef.current;
    if (map) { map.setZoom(z); }
  };

  // Sync selectedWaypointId from parent to internal selectedWp
  useEffect(() => {
    if (!selectedWaypointId) {
      setSelectedWp(null);
      return;
    }
    const wp = waypoints.find((w) => w.id === selectedWaypointId);
    if (wp) setSelectedWp(wp);
  }, [selectedWaypointId, waypoints]);

  // Determine hero image source and photo gallery
  const allPhotos = useMemo(() => {
    if (!selectedWp) return [];
    if (selectedWp.photos && selectedWp.photos.length > 0) return selectedWp.photos;
    if (selectedWp.photoUrl) return [{ url: selectedWp.photoUrl }];
    return [];
  }, [selectedWp]);

  const heroImage = allPhotos.length > 0 ? allPhotos[heroImageIndex]?.url || allPhotos[0].url : null;

  const ratingNum = selectedWp?.rating ? parseFloat(selectedWp.rating) : 0;
  const filledStars = Math.min(5, Math.max(0, Math.round(ratingNum)));

  const panelPlacement = useMemo(() => {
    if (!clickPixel || !mapContainerSize.width) return { placement: "bottom" as const, style: {} };
    const panelW = 320;
    const panelH = 300;
    const padding = 20;

    // Default: show above the click point
    let placement: "top" | "bottom" | "left" | "right" = "top";

    // If too close to top, show below
    if (clickPixel.y < panelH + padding * 2) placement = "bottom";

    // Horizontal alignment
    let left = clickPixel.x;
    if (left < panelW / 2 + padding) left = panelW / 2 + padding;
    if (left > mapContainerSize.width - panelW / 2 - padding) {
      left = mapContainerSize.width - panelW / 2 - padding;
    }

    return { placement, style: { left, top: clickPixel.y } };
  }, [clickPixel, mapContainerSize]);

  return (
    <section
      className={`map-canvas ${realMapState === "ready" ? "has-real-map" : ""}`}
      aria-label="路线地图"
    >
      <div
        className={`amap-real-layer ${realMapState === "ready" ? "is-ready" : ""}`}
        ref={mapRef}
      />


      {/* Loading overlay */}
      {realMapState === "loading" && (
        <div className="map-loading-overlay">
          <div className="map-loading-brand">
            {"Along 同路".split("").map((char, i) => (
              <span key={i} style={{ animationDelay: `${i * 0.1}s` }}>
                {char === " " ? " " : char}
              </span>
            ))}
            <span className="map-loading-cursor" />
          </div>
          <p>正在加载地图…</p>
        </div>
      )}

      {/* Error overlay */}
      {realMapState === "error" && (
        <div className="map-error-overlay">
          <AlertCircle size={28} />
          <p>地图加载失败</p>
          <button
            className="map-error-retry"
            onClick={() => {
              mapInitRef.current = false;
              setRealMapState("disabled");
            }}
            type="button"
          >
            <RefreshCw size={12} />
            重试
          </button>
        </div>
      )}

      {/* No-key hint overlay */}
      {realMapState === "disabled" && !hasKey && (
        <div className="map-nokey-hint">
          <MapPin size={20} />
          <p>
            地图服务需配置高德 API Key
            <br />
            <span>请在 .env.local 中设置 NEXT_PUBLIC_AMAP_JS_KEY</span>
          </p>
        </div>
      )}

      {realMapState !== "ready" && resolvedWaypoints.length === 0 && (
        <div className="map-empty-hint">
          <Navigation2 size={32} />
          <p>等待 AI 规划路线…</p>
        </div>
      )}

      {/* ===== Custom Detail Panel V2 ===== */}
      {selectedWp && (
        <div className="map-detail-panel-v2 is-visible">
          {/* Close button */}
          <button
            className="map-detail-panel-v2-close"
            onClick={() => setSelectedWp(null)}
            type="button"
            aria-label="关闭详情"
          >
            <X size={16} />
          </button>

          {/* Searching skeleton */}
          {selectedWp.resolveStatus === "searching" && (
            <div className="map-detail-panel-v2-skeleton">
              <div className="v2-skeleton-hero" />
              <div className="v2-skeleton-title" />
              <div className="v2-skeleton-line" />
              <div className="v2-skeleton-line short" />
            </div>
          )}

          {/* Not found state */}
          {selectedWp.resolveStatus === "not_found" && (
            <div className="map-detail-panel-v2-empty">
              <MapPin size={32} color="#ccc" />
              <p>暂无详细信息</p>
              <span>该地点暂时无法获取详情</span>
            </div>
          )}

          {/* Ready state */}
          {selectedWp.resolveStatus === "ready" && (
            <div className="map-detail-panel-v2-body">
              {/* Hero image */}
              {heroImage ? (
                <div className="map-detail-panel-v2-hero">
                  <img src={heroImage} alt={selectedWp.name} />
                </div>
              ) : (
                <div className="map-detail-panel-v2-hero placeholder">
                  <MapPin size={28} color="#ccc" />
                </div>
              )}

              {/* Photo gallery thumbnails */}
              {allPhotos.length > 1 && (
                <div className="map-detail-gallery">
                  {allPhotos.map((photo, idx) => (
                    <button
                      key={idx}
                      className={`map-detail-gallery-thumb ${idx === heroImageIndex ? "is-active" : ""}`}
                      onClick={() => setHeroImageIndex(idx)}
                      type="button"
                      aria-label={`查看图片 ${idx + 1}`}
                    >
                      <img src={photo.url} alt={photo.title || `${selectedWp.name} ${idx + 1}`} />
                    </button>
                  ))}
                </div>
              )}

              {/* Title + rating bar */}
              <div className="map-detail-panel-v2-title-row">
                <h3>{selectedWp.name}</h3>
              </div>

              {selectedWp.rating && (
                <div className="map-detail-rating-bar">
                  <div className="stars">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star
                        key={i}
                        size={14}
                        className={i < filledStars ? "star is-filled" : "star"}
                        fill={i < filledStars ? "#f5b041" : "none"}
                        color={i < filledStars ? "#f5b041" : "var(--ink-200)"}
                      />
                    ))}
                  </div>
                  <span className="score">{selectedWp.rating}</span>
                  <span className="reviews">{ratingLabel(ratingNum)}</span>
                </div>
              )}

              {/* Category + area badge row */}
              {(selectedWp.category || selectedWp.address) && (
                <div className="map-detail-panel-v2-tags">
                  {selectedWp.category && (
                    <span className="map-detail-panel-v2-tag tag-coral">{selectedWp.category}</span>
                  )}
                  {selectedWp.address && (
                    <span className="map-detail-panel-v2-tag tag-mint">
                      {selectedWp.address.split(/[区市县]/)[0]}
                    </span>
                  )}
                </div>
              )}

              {/* Review section */}
              {selectedWpReview && (
                <div className="map-detail-section">
                  <div className="map-detail-review-summary">
                    <p>{selectedWpReview.summary}</p>
                  </div>
                  <div className="map-detail-review-tags">
                    {selectedWpReview.tags.map((tag) => (
                      <span key={tag} className="map-detail-review-tag">{tag}</span>
                    ))}
                  </div>
                  {selectedWpReview.tips && (
                    <div className="map-detail-review-tip">
                      <span>💡 {selectedWpReview.tips}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Action button */}
              {onAddWaypoint && selectedWp.location && (
                <button
                  type="button"
                  className="map-detail-action-btn"
                  onClick={() => {
                    if (!selectedWp.location) return;
                    onAddWaypoint({
                      id: selectedWp.id,
                      name: selectedWp.name,
                      location: selectedWp.location,
                      address: selectedWp.address,
                    });
                  }}
                >
                  <Plus size={16} />
                  加入行程
                </button>
              )}

              {/* Info sections */}
              <div className="map-detail-section">
                <div className="map-detail-panel-v2-info">
                  {selectedWp.address && (
                    <div className="v2-info-row">
                      <MapPin size={14} color="#888" />
                      <span>{selectedWp.address}</span>
                    </div>
                  )}
                </div>
              </div>

              {(selectedWp.businessHours || selectedWp.cost) && (
                <div className="map-detail-section">
                  <div className="map-detail-panel-v2-info">
                    {selectedWp.businessHours && (
                      <div className="v2-info-row">
                        <Clock size={14} color="#888" />
                        <span>{selectedWp.businessHours}</span>
                      </div>
                    )}
                    {selectedWp.cost && (
                      <div className="v2-info-row">
                        <Banknote size={14} color="#888" />
                        <span>{selectedWp.cost}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Description */}
              {selectedWp.description && (
                <div className="map-detail-section">
                  <div className="map-detail-panel-v2-desc">
                    <p>{selectedWp.description}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {realMapState === "ready" && (
        <div className="map-mode-switch" role="group" aria-label="地图模式">
          <button className={mapMode === "map" ? "is-active" : ""} onClick={() => changeMode("map")} type="button">标准</button>
          <button className={mapMode === "satellite" ? "is-active" : ""} onClick={() => changeMode("satellite")} type="button">卫星</button>
        </div>
      )}

      {/* ===== Clicked POI Panel ===== */}
      {clickPosition && clickPixel && (
        <div
          className={`map-poi-panel is-placement-${panelPlacement.placement}`}
          style={panelPlacement.style}
        >
          <div className="map-poi-panel-header">
            <strong>附近地点</strong>
            <button
              onClick={() => {
                setClickedPois([]);
                setClickPixel(null);
              }}
              type="button"
            >
              ×
            </button>
          </div>
          <div className="map-poi-list">
            {clickedPois.length === 0 ? (
              <div className="map-poi-empty">
                附近暂无景点或餐厅推荐，试试点击其他地方
              </div>
            ) : (
              clickedPois.map((poi: any, idx: number) => {
                const poiLoc = parsePoiLocation(poi);
                const distance = poiLoc ? haversineDistance(clickPosition, poiLoc) : null;
                const poiRating = poi.rating ? parseFloat(poi.rating) : 0;
                const poiCategory = poi.type ? String(poi.type).split(";")[0] : "";
                const reviewData = poiReviews.get(poi.name);
                return (
                  <div key={idx} className="map-poi-item">
                    <div className="map-poi-info">
                      <div className="map-poi-name">{poi.name}</div>
                      <div className="map-poi-meta">
                        {distance !== null && (
                          <span className="map-poi-distance">{formatDistance(distance)}</span>
                        )}
                        {!reviewData && poiRating > 0 && (
                          <span className="map-poi-rating-mini">
                            <Star size={10} fill="#ff8c00" color="#ff8c00" />
                            {poi.rating}
                          </span>
                        )}
                        {poiCategory && (
                          <span className="map-poi-category-tag">{poiCategory}</span>
                        )}
                      </div>
                      {reviewData && (
                        <div className="map-poi-review-summary">
                          {truncate(reviewData.summary, 40)}
                        </div>
                      )}
                      {reviewData && (
                        <div className="map-poi-review-footer">
                          <div className="map-poi-review-tags">
                            {reviewData.tags.slice(0, 2).map((tag) => (
                              <span key={tag} className="map-poi-review-tag">
                                {tag}
                              </span>
                            ))}
                          </div>
                          <span className="map-poi-review-count">
                            {formatReviewCount(reviewData.reviewCount)}
                          </span>
                        </div>
                      )}
                      <div className="map-poi-address">{poi.address || ""}</div>
                    </div>
                    <button
                      type="button"
                      className="map-poi-add-btn"
                      onClick={() => {
                        if (onAddWaypoint) {
                          let lng = clickPosition[0];
                          let lat = clickPosition[1];
                          const loc = poi.location;
                          if (typeof loc === "string") {
                            const parts = loc.split(",");
                            const parsedLng = Number(parts[0]);
                            const parsedLat = Number(parts[1]);
                            if (Number.isFinite(parsedLng)) lng = parsedLng;
                            if (Number.isFinite(parsedLat)) lat = parsedLat;
                          } else if (Array.isArray(loc) && loc.length >= 2) {
                            const parsedLng = Number(loc[0]);
                            const parsedLat = Number(loc[1]);
                            if (Number.isFinite(parsedLng)) lng = parsedLng;
                            if (Number.isFinite(parsedLat)) lat = parsedLat;
                          } else if (loc && typeof loc === "object") {
                            const parsedLng = Number(loc.lng ?? loc.getLng?.() ?? loc.longitude);
                            const parsedLat = Number(loc.lat ?? loc.getLat?.() ?? loc.latitude);
                            if (Number.isFinite(parsedLng)) lng = parsedLng;
                            if (Number.isFinite(parsedLat)) lat = parsedLat;
                          }
                          onAddWaypoint({
                            id: `poi-${Date.now()}-${idx}`,
                            name: poi.name,
                            location: [lng, lat],
                            address: poi.address || "",
                          });
                          setClickedPois([]);
                          setClickPixel(null);
                        }
                      }}
                    >
                      加入行程
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

    </section>
  );
}
