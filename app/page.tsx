"use client";

import { useCallback, useEffect, useState } from "react";

type Config = {
  id: string;
  name: string;
  enabled: boolean;
  tripType: "oneway" | "roundtrip";
  origin: string;
  dest: string;
  departFrom: string;
  departTo: string;
  returnFrom: string | null;
  returnTo: string | null;
  minPrice: number;
  maxPrice: number;
  discordWebhookUrl: string;
  pollMinutes: number;
  lastRunAt: string | null;
  lastError: string | null;
};

type Alert = {
  id: string;
  origin: string;
  dest: string;
  departDate: string;
  returnDate: string | null;
  price: number;
  flightNo: string | null;
  deeplink: string | null;
  notifiedAt: string;
  config: { name: string } | null;
};

type Settings = { running: boolean };

type Airport = { code: string; city: string; airport: string; country: string };

type FormState = {
  name: string;
  enabled: boolean;
  tripType: "oneway" | "roundtrip";
  origin: string;
  dest: string;
  departFrom: string;
  departTo: string;
  returnFrom: string;
  returnTo: string;
  minPrice: number;
  maxPrice: number;
  pollMinutes: number;
  discordWebhookUrl: string;
};

const blank: FormState = {
  name: "",
  enabled: true,
  tripType: "oneway",
  origin: "SGN",
  dest: "HAN",
  departFrom: "",
  departTo: "",
  returnFrom: "",
  returnTo: "",
  minPrice: 0,
  maxPrice: 1_000_000,
  pollMinutes: 20,
  discordWebhookUrl: "",
};

const vnd = (n: number) => `${n.toLocaleString("vi-VN")} ₫`;

/**
 * Falls back to a plain text box if the airport list could not be fetched, so a
 * Vietjet outage cannot lock you out of editing configs.
 */
function AirportPicker({
  airports,
  value,
  onChange,
  className,
}: {
  airports: Airport[];
  value: string;
  onChange: (code: string) => void;
  className: string;
}) {
  if (!airports.length) {
    return (
      <input
        className={className}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        maxLength={3}
        placeholder="SGN"
        required
      />
    );
  }

  // The API returns countries in Vietjet's own priority order (Vietnam first)
  // and object key insertion order preserves it, so no sorting is needed here.
  const byCountry = airports.reduce<Record<string, Airport[]>>((acc, a) => {
    (acc[a.country] ??= []).push(a);
    return acc;
  }, {});

  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">— Chọn sân bay —</option>
      {Object.entries(byCountry).map(([country, list]) => (
        <optgroup key={country} label={country}>
          {list.map((a) => (
            <option key={a.code} value={a.code} title={a.airport}>
              {a.city} ({a.code})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function Home() {
  const [configs, setConfigs] = useState<Config[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [form, setForm] = useState<FormState>(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [airports, setAirports] = useState<Airport[]>([]);

  const load = useCallback(async () => {
    const [c, a, s, ap] = await Promise.all([
      fetch("/api/configs").then((r) => r.json()),
      fetch("/api/alerts").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/airports")
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    ]);
    setConfigs(c);
    setAlerts(a);
    setSettings(s);
    if (Array.isArray(ap)) setAirports(ap);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const body = {
      ...form,
      minPrice: Number(form.minPrice),
      maxPrice: Number(form.maxPrice),
      pollMinutes: Number(form.pollMinutes),
      returnFrom: form.tripType === "roundtrip" ? form.returnFrom || null : null,
      returnTo: form.tripType === "roundtrip" ? form.returnTo || null : null,
    };
    try {
      const res = await fetch(editingId ? `/api/configs/${editingId}` : "/api/configs", {
        method: editingId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(detail?.error ?? `Lưu thất bại (HTTP ${res.status})`);
        return;
      }
      setForm(blank);
      setEditingId(null);
      await load();
    } catch {
      setError("Không gọi được server. Kiểm tra xem `npm run dev` còn chạy không rồi thử lại.");
    }
  }

  function edit(c: Config) {
    setEditingId(c.id);
    setError("");
    setForm({
      name: c.name,
      enabled: c.enabled,
      tripType: c.tripType,
      origin: c.origin,
      dest: c.dest,
      departFrom: c.departFrom,
      departTo: c.departTo,
      returnFrom: c.returnFrom ?? "",
      returnTo: c.returnTo ?? "",
      minPrice: c.minPrice,
      maxPrice: c.maxPrice,
      pollMinutes: c.pollMinutes,
      discordWebhookUrl: c.discordWebhookUrl,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function setRunning(running: boolean) {
    const next = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ running }),
    }).then((r) => r.json());
    setSettings(next);
    setError(
      running
        ? "Đã bật — mỗi config sẽ tự quét theo chu kỳ của nó."
        : "Đã dừng — không quét nữa cho tới khi bấm Start.",
    );
  }

  async function runAll() {
    setBusy("all");
    setError("");
    try {
      const results = await fetch("/api/run-all", { method: "POST" }).then((r) => r.json());
      const notified = results.reduce((n: number, r: any) => n + (r.notified ?? 0), 0);
      setError(`Đã chạy ${results.length} config, bắn ${notified} noti.`);
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function toggle(c: Config) {
    await fetch(`/api/configs/${c.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !c.enabled }),
    });
    await load();
  }

  async function remove(c: Config) {
    if (!confirm(`Xoá config "${c.name}"?`)) return;
    await fetch(`/api/configs/${c.id}`, { method: "DELETE" });
    await load();
  }

  async function checkNow(c: Config) {
    setBusy(c.id);
    setError("");
    try {
      const res = await fetch(`/api/configs/${c.id}/run`, { method: "POST" });
      const r = await res.json();
      if (r.error) setError(`${c.name}: ${r.error}`);
      else setError(`${c.name}: quét ${r.scanned} vé, khớp ${r.matched}, bắn ${r.notified} noti.`);
    } finally {
      setBusy(null);
      await load();
    }
  }

  const placeLabel = (code: string) => {
    const a = airports.find((x) => x.code === code);
    return a ? `${a.city} (${code})` : code;
  };

  const field = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-red-500";
  const label = "mb-1 block text-xs font-medium text-slate-500";

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Vietjet Fare Watcher</h1>
        <p className="mt-1 text-sm text-slate-500">
          Quét giá theo chu kỳ, vé rơi vào ngưỡng thì bắn Discord.
        </p>
      </header>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={`inline-block h-3 w-3 rounded-full ${
                settings?.running ? "animate-pulse bg-emerald-500" : "bg-slate-300"
              }`}
            />
            <div>
              <p className="font-semibold text-slate-900">
                {settings?.running ? "Đang polling" : "Đang dừng"}
              </p>
              <p className="text-sm text-slate-500">
                {settings?.running
                  ? `${configs.filter((c) => c.enabled).length} config đang bật, mỗi cái quét theo chu kỳ riêng`
                  : "Thêm config rồi bấm Start để bắt đầu quét"}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            {settings?.running ? (
              <button
                onClick={() => setRunning(false)}
                className="rounded-md bg-slate-900 px-6 py-2 text-sm font-semibold text-white"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => setRunning(true)}
                disabled={!settings}
                className="rounded-md bg-emerald-600 px-6 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Start
              </button>
            )}
            <button
              onClick={runAll}
              disabled={busy === "all"}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 disabled:opacity-50"
            >
              {busy === "all" ? "Đang quét…" : "Quét ngay 1 lượt"}
            </button>
          </div>
        </div>
      </section>

      <section className="mb-10 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 font-semibold text-slate-900">
          {editingId ? "Sửa config" : "Thêm config"}
        </h2>

        <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className={label}>Tên config</label>
            <input
              className={field}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Tết về quê"
              required
            />
          </div>
          <div>
            <label className={label}>Loại chuyến</label>
            <select
              className={field}
              value={form.tripType}
              onChange={(e) => set("tripType", e.target.value as "oneway" | "roundtrip")}
            >
              <option value="oneway">Một chiều</option>
              <option value="roundtrip">Khứ hồi</option>
            </select>
          </div>

          <div>
            <label className={label}>Điểm đi</label>
            <AirportPicker
              airports={airports}
              value={form.origin}
              onChange={(v) => set("origin", v)}
              className={field}
            />
          </div>
          <div>
            <label className={label}>Điểm đến</label>
            <AirportPicker
              airports={airports}
              value={form.dest}
              onChange={(v) => set("dest", v)}
              className={field}
            />
          </div>
          <div />

          <div>
            <label className={label}>Ngày đi từ</label>
            <input
              type="date"
              className={field}
              value={form.departFrom}
              onChange={(e) => set("departFrom", e.target.value)}
              required
            />
          </div>
          <div>
            <label className={label}>Ngày đi đến</label>
            <input
              type="date"
              className={field}
              value={form.departTo}
              onChange={(e) => set("departTo", e.target.value)}
              required
            />
          </div>
          <div />

          {form.tripType === "roundtrip" && (
            <>
              <div>
                <label className={label}>Ngày về từ</label>
                <input
                  type="date"
                  className={field}
                  value={form.returnFrom}
                  onChange={(e) => set("returnFrom", e.target.value)}
                  required
                />
              </div>
              <div>
                <label className={label}>Ngày về đến</label>
                <input
                  type="date"
                  className={field}
                  value={form.returnTo}
                  onChange={(e) => set("returnTo", e.target.value)}
                  required
                />
              </div>
              <div />
            </>
          )}

          <div>
            <label className={label}>Giá từ (VND)</label>
            <input
              type="number"
              min={0}
              className={field}
              value={form.minPrice}
              onChange={(e) => set("minPrice", Number(e.target.value))}
            />
          </div>
          <div>
            <label className={label}>
              Giá đến (VND){form.tripType === "roundtrip" ? " — tổng khứ hồi" : ""}
            </label>
            <input
              type="number"
              min={1}
              className={field}
              value={form.maxPrice}
              onChange={(e) => set("maxPrice", Number(e.target.value))}
              required
            />
          </div>
          <div>
            <label className={label}>Quét lại mỗi</label>
            <select
              className={field}
              value={form.pollMinutes}
              onChange={(e) => set("pollMinutes", Number(e.target.value))}
            >
              <option value={5}>5 phút</option>
              <option value={10}>10 phút</option>
              <option value={15}>15 phút</option>
              <option value={20}>20 phút</option>
              <option value={30}>30 phút</option>
              <option value={60}>1 tiếng</option>
              <option value={180}>3 tiếng</option>
              <option value={360}>6 tiếng</option>
              <option value={720}>12 tiếng</option>
              <option value={1440}>1 ngày</option>
            </select>
          </div>

          <div className="flex items-end pb-2 sm:col-span-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              Bật poll
            </label>
          </div>

          <div className="sm:col-span-3">
            <label className={label}>Discord webhook URL</label>
            <input
              className={field}
              value={form.discordWebhookUrl}
              onChange={(e) => set("discordWebhookUrl", e.target.value)}
              placeholder="https://discord.com/api/webhooks/..."
              required
            />
          </div>

          <div className="flex gap-3 sm:col-span-3">
            <button
              type="submit"
              className="rounded-md bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700"
            >
              {editingId ? "Lưu thay đổi" : "Thêm config"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(blank);
                }}
                className="rounded-md border border-slate-300 px-5 py-2 text-sm text-slate-600"
              >
                Huỷ
              </button>
            )}
          </div>
        </form>

        {error && (
          <p className="mt-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">{error}</p>
        )}
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-semibold text-slate-900">Config ({configs.length})</h2>
        {configs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
            Chưa có config nào.
          </p>
        ) : (
          <div className="space-y-3">
            {configs.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${c.enabled ? "bg-emerald-500" : "bg-slate-300"}`}
                      />
                      <span className="font-semibold text-slate-900">{c.name}</span>
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                        {c.tripType === "roundtrip" ? "Khứ hồi" : "Một chiều"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">
                      {placeLabel(c.origin)} → {placeLabel(c.dest)} · đi {c.departFrom} → {c.departTo}
                      {c.returnFrom && ` · về ${c.returnFrom} → ${c.returnTo}`}
                    </p>
                    <p className="text-sm text-slate-500">
                      Ngưỡng {vnd(c.minPrice)} – {vnd(c.maxPrice)} · quét mỗi{" "}
                      {c.pollMinutes >= 60
                        ? `${c.pollMinutes / 60} tiếng`
                        : `${c.pollMinutes} phút`}
                      {c.lastRunAt && ` · chạy lúc ${new Date(c.lastRunAt).toLocaleString("vi-VN")}`}
                    </p>
                    {c.lastError && (
                      <p className="mt-1 text-sm text-red-600">Lỗi lần chạy trước: {c.lastError}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => checkNow(c)}
                      disabled={busy === c.id}
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {busy === c.id ? "Đang quét…" : "Check now"}
                    </button>
                    <button
                      onClick={() => toggle(c)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
                    >
                      {c.enabled ? "Tắt" : "Bật"}
                    </button>
                    <button
                      onClick={() => edit(c)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
                    >
                      Sửa
                    </button>
                    <button
                      onClick={() => remove(c)}
                      className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-600"
                    >
                      Xoá
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-semibold text-slate-900">Noti gần đây</h2>
        {alerts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
            Chưa bắn noti nào.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-4 py-3">Lúc</th>
                  <th className="px-4 py-3">Config</th>
                  <th className="px-4 py-3">Chặng</th>
                  <th className="px-4 py-3">Ngày</th>
                  <th className="px-4 py-3">Chuyến</th>
                  <th className="px-4 py-3 text-right">Giá</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(a.notifiedAt).toLocaleString("vi-VN")}
                    </td>
                    <td className="px-4 py-3">{a.config?.name ?? "—"}</td>
                    <td className="px-4 py-3">
                      {a.origin} → {a.dest}
                    </td>
                    <td className="px-4 py-3">
                      {a.departDate}
                      {a.returnDate && ` / ${a.returnDate}`}
                    </td>
                    <td className="px-4 py-3">{a.flightNo ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-semibold text-red-600">
                      {a.deeplink ? (
                        <a href={a.deeplink} target="_blank" rel="noreferrer" className="underline">
                          {vnd(a.price)}
                        </a>
                      ) : (
                        vnd(a.price)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
