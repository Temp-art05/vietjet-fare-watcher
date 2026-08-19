import { NextResponse } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/api";
import { getSettings, updateSettings } from "@/lib/db";

export const runtime = "nodejs";

const patchSchema = z.object({ running: z.boolean() });

export async function GET() {
  return handle(async () => NextResponse.json(await getSettings()));
}

export async function PUT(req: Request) {
  return handle(async () => {
    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    return NextResponse.json(await updateSettings(parsed.data));
  });
}
