import { NextResponse } from "next/server";
import { z } from "zod";
import { getSettings, updateSettings } from "@/lib/settings";

export const runtime = "nodejs";

const patchSchema = z.object({ running: z.boolean() });

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function PUT(req: Request) {
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  return NextResponse.json(await updateSettings(parsed.data));
}
