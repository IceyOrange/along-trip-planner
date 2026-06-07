import { NextResponse } from "next/server";
import { createHmac, createHash } from "node:crypto";

function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

function hmacSha1Base64(secret: string, data: string): string {
  return createHmac("sha1", secret).update(data, "utf8").digest("base64");
}

function buildSigna(appid: string, ts: string, apiKey: string): string {
  const baseString = appid + ts;
  const md5 = md5Hex(baseString);
  return hmacSha1Base64(apiKey, md5);
}

export async function GET() {
  const appid = process.env.APPID?.trim().replace(/[\x00-\x1F\x7F]/g, "");
  const apiKey = process.env.APIKey?.trim().replace(/[\x00-\x1F\x7F]/g, "");

  if (!appid || !apiKey) {
    return NextResponse.json(
      { error: "科大讯飞 ASR 凭证未配置" },
      { status: 500 },
    );
  }

  const ts = Math.floor(Date.now() / 1000).toString();
  const signa = buildSigna(appid, ts, apiKey);

  const params = new URLSearchParams({
    appid,
    ts,
    signa,
    lang: "cn",
    punc: "1",
    vad_eos: "4000",
    dwa: "wpgs",
  });

  const url = `wss://rtasr.xfyun.cn/v1/ws?${params.toString()}`;

  return NextResponse.json({ url });
}
