import { NextResponse } from "next/server";
import { requestAmap } from "@/lib/server/amap";

type RouteMode = "driving" | "walking" | "bicycling" | "transit";

const modeToPath: Record<RouteMode, string> = {
  driving: "/v5/direction/driving",
  walking: "/v5/direction/walking",
  bicycling: "/v5/direction/bicycling",
  
  transit: "/v5/direction/transit/integrated",
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const origin = typeof body.origin === "string" ? body.origin.trim() : "";
  const destination =
    typeof body.destination === "string" ? body.destination.trim() : "";
  const mode = (
    ["driving", "walking", "bicycling", "transit"].includes(body.mode)
      ? body.mode
      : "walking"
  ) as RouteMode;
  const city = typeof body.city === "string" ? body.city.trim() : undefined;
  const city1 = typeof body.city1 === "string" ? body.city1.trim() : city;
  const city2 = typeof body.city2 === "string" ? body.city2.trim() : city1;
  const waypoints = Array.isArray(body.waypoints)
    ? body.waypoints.filter((point: unknown) => typeof point === "string").join(";")
    : undefined;

  if (!origin || !destination) {
    return NextResponse.json(
      { error: "ORIGIN_AND_DESTINATION_REQUIRED" },
      { status: 400 },
    );
  }

  const result = await requestAmap(modeToPath[mode], {
    origin,
    destination,
    waypoints,
    city1: mode === "transit" ? city1 : undefined,
    city2: mode === "transit" ? city2 : undefined,
    show_fields: "cost,navi,polyline",
  });

  return NextResponse.json(result, {
    status: result.configured ? 200 : 501,
  });
}
