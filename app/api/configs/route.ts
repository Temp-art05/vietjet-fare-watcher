import { NextResponse } from "next/server";
import { createConfig, listConfigs } from "@/lib/db";
import { configSchema } from "@/lib/schema";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await listConfigs());
}

export async function POST(req: Request) {
  const parsed = configSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  return NextResponse.json(await createConfig(parsed.data), { status: 201 });
}
