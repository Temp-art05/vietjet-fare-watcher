import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { configSchema } from "@/lib/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = configSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const config = await prisma.watchConfig.update({ where: { id }, data: parsed.data });
  return NextResponse.json(config);
}

/** Toggle enabled without resubmitting the whole form. */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "Chỉ nhận { enabled: boolean }" }, { status: 400 });
  }
  const config = await prisma.watchConfig.update({ where: { id }, data: { enabled: body.enabled } });
  return NextResponse.json(config);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await prisma.watchConfig.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
