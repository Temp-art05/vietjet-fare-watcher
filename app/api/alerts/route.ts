import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const alerts = await prisma.alert.findMany({
    orderBy: { notifiedAt: "desc" },
    take: 50,
    include: { config: { select: { name: true } } },
  });
  return NextResponse.json(alerts);
}
