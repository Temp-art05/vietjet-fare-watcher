import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { deleteConfig, setConfigEnabled, updateConfig } from "@/lib/db";
import { configSchema } from "@/lib/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "Không tìm thấy config" }, { status: 404 });

export async function PUT(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const parsed = configSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const config = await updateConfig(id, parsed.data);
    return config ? NextResponse.json(config) : notFound();
  });
}

/** Toggle enabled without resubmitting the whole form. */
export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = await req.json();
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "Chỉ nhận { enabled: boolean }" }, { status: 400 });
    }
    const config = await setConfigEnabled(id, body.enabled);
    return config ? NextResponse.json(config) : notFound();
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    return (await deleteConfig(id)) ? NextResponse.json({ ok: true }) : notFound();
  });
}
