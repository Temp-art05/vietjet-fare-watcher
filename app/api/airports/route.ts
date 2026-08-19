import { NextResponse } from "next/server";
import { getAirports } from "@/lib/airports";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await getAirports());
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách sân bay" }, { status: 502 });
  }
}
