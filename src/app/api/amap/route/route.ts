import { NextResponse } from "next/server";
import { requestAmap } from "@/lib/server/amap";

type RouteMode = "driving" | "walking" | "bicycling" | "transit";

const modeToPath: Record<RouteMode, string> = {
  driving: "/v5/direction/driving",
  walking: "/v5/direction/walking",
  bicycling: "/v5/direction/bicycling",

  transit: "/v5/direction/transit/integrated",
};

// AMap v5 transit API requires city codes (adcode) for city1/city2, not city names.
const cityNameToAdcode: Record<string, string> = {
  北京: "110000", 北京市: "110000",
  天津: "120000", 天津市: "120000",
  上海: "310000", 上海市: "310000",
  重庆: "500000", 重庆市: "500000",
  广州: "440100", 广州市: "440100",
  深圳: "440300", 深圳市: "440300",
  珠海: "440400", 珠海市: "440400",
  东莞: "441900", 东莞市: "441900",
  佛山: "440600", 佛山市: "440600",
  杭州: "330100", 杭州市: "330100",
  宁波: "330200", 宁波市: "330200",
  温州: "330300", 温州市: "330300",
  南京: "320100", 南京市: "320100",
  苏州: "320500", 苏州市: "320500",
  无锡: "320200", 无锡市: "320200",
  常州: "320400", 常州市: "320400",
  成都: "510100", 成都市: "510100",
  西安: "610100", 西安市: "610100",
  武汉: "420100", 武汉市: "420100",
  长沙: "430100", 长沙市: "430100",
  郑州: "410100", 郑州市: "410100",
  昆明: "530100", 昆明市: "530100",
  哈尔滨: "230100", 哈尔滨市: "230100",
  沈阳: "210100", 沈阳市: "210100",
  大连: "210200", 大连市: "210200",
  济南: "370100", 济南市: "370100",
  青岛: "370200", 青岛市: "370200",
  烟台: "370600", 烟台市: "370600",
  厦门: "350200", 厦门市: "350200",
  福州: "350100", 福州市: "350100",
  合肥: "340100", 合肥市: "340100",
  南昌: "360100", 南昌市: "360100",
  贵阳: "520100", 贵阳市: "520100",
  兰州: "620100", 兰州市: "620100",
  海口: "460100", 海口市: "460100",
  三亚: "460200", 三亚市: "460200",
  南宁: "450100", 南宁市: "450100",
  桂林: "450300", 桂林市: "450300",
  拉萨: "540100", 拉萨市: "540100",
  乌鲁木齐: "650100", 乌鲁木齐市: "650100",
  银川: "640100", 银川市: "640100",
  西宁: "630100", 西宁市: "630100",
  呼和浩特: "150100", 呼和浩特市: "150100",
  太原: "140100", 太原市: "140100",
  石家庄: "130100", 石家庄市: "130100",
  长春: "220100", 长春市: "220100",
  唐山: "130200", 唐山市: "130200",
  秦皇岛: "130300", 秦皇岛市: "130300",
  威海: "371000", 威海市: "371000",
  洛阳: "410300", 洛阳市: "410300",
  开封: "410200", 开封市: "410200",
  扬州: "321000", 扬州市: "321000",
  镇江: "321100", 镇江市: "321100",
  绍兴: "330600", 绍兴市: "330600",
  嘉兴: "330400", 嘉兴市: "330400",
  台州: "331000", 台州市: "331000",
  金华: "330700", 金华市: "330700",
  湖州: "330500", 湖州市: "330500",
  南通: "320600", 南通市: "320600",
  徐州: "320300", 徐州市: "320300",
  连云港: "320700", 连云港市: "320700",
  淮安: "320800", 淮安市: "320800",
  盐城: "320900", 盐城市: "320900",
  泰州: "321200", 泰州市: "321200",
  宿迁: "321300", 宿迁市: "321300",
};

function normalizeCityCode(city?: string): string | undefined {
  if (!city) return undefined;
  // If already numeric, pass through
  if (/^\d+$/.test(city)) return city;
  return cityNameToAdcode[city];
}

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

  // AMap transit API requires numeric city codes; fallback to original value if not in map
  const transitCity1 = mode === "transit" ? (normalizeCityCode(city1) || city1) : undefined;
  const transitCity2 = mode === "transit" ? (normalizeCityCode(city2) || city2) : undefined;

  const result = await requestAmap(modeToPath[mode], {
    origin,
    destination,
    waypoints,
    city1: transitCity1,
    city2: transitCity2,
    show_fields: "cost,navi,polyline",
  });

  return NextResponse.json(result, {
    status: result.configured ? 200 : 501,
  });
}
