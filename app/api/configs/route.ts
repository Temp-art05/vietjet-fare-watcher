import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { configSchema } from "@/lib/schema";

export const runtime = "nodejs";

export async function GET() {
  const configs = await prisma.watchConfig.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(configs);
}

export async function POST(req: Request) {
  const parsed = configSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const config = await prisma.watchConfig.create({ data: parsed.data });
  return NextResponse.json(config, { status: 201 });
}
