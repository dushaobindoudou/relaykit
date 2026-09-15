"use client";

/**
 * 后台 · 收款账号管理（/admin）。
 *
 * 最小可用版：令牌登入 → 编辑人工收款渠道（支付宝/微信的账号、
 * 收款码图片、转账说明、启用位）→ 保存到 settings 表。
 *
 * 收款码图片在前端用 canvas 压到最长边 640px 再转 data URI 入库
 * —— Workers 没有图像库，R2 也没开，这样够用且零基础设施。
 * 数据 URI 上限由 API 端 zod 兜底（400KB）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface Channel {
  id: string;
  label: string;
  account: string;
  qrImage?: string | undefined;
  instructions?: string | undefined;
  enabled: boolean;
}

const TOKEN_KEY = "daichong_admin_token";

/** 压缩成最长边 640px 的 PNG data URI（二维码保持锐利）。 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("不是有效的图片"));
      img.onload = () => {
        const max = 640;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("canvas 不可用"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [markupPercent, setMarkupPercent] = useState("30");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<number | null>(null);

  const load = useCallback(async (bearer: string) => {
    const response = await fetch("/api/admin/channels", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) throw new Error(response.status === 401 ? "令牌不对" : "加载失败");
    const data = (await response.json()) as { channels: Channel[]; markupPercent: string };
    setChannels(data.channels);
    setMarkupPercent(data.markupPercent);
    setAuthed(true);
    sessionStorage.setItem(TOKEN_KEY, bearer);
  }, []);

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) load(saved).catch(() => sessionStorage.removeItem(TOKEN_KEY));
  }, [load]);

  async function save(next: Channel[]) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/admin/channels", {
        method: "POST",
        headers: { authorization: `Bearer ${token || sessionStorage.getItem(TOKEN_KEY) || ""}`, "content-type": "application/json" },
        body: JSON.stringify({ channels: next }),
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "保存失败");
      setChannels(next);
      setStatus("已保存，前台即时生效");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  function patch(index: number, changes: Partial<Channel>) {
    setChannels((prev) => prev.map((item, i) => (i === index ? { ...item, ...changes } : item)));
  }

  async function onPickImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || uploadTarget.current === null) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      if (dataUrl.length > 400_000) {
        setError("图片压缩后仍超过 400KB，请换一张更简洁的收款码");
        return;
      }
      patch(uploadTarget.current, { qrImage: dataUrl });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传失败");
    } finally {
      uploadTarget.current = null;
    }
  }

  // —— 登录态 ——
  if (!authed) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-[18px] font-bold">后台 · 收款账号</h1>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="ADMIN_TOKEN"
          className="h-11 rounded-xl border border-[#d8dde3] bg-white px-3 text-[14px]"
        />
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await load(token);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "登录失败");
            } finally {
              setBusy(false);
            }
          }}
          className="h-11 rounded-xl bg-[#1c5f45] text-[14px] font-semibold text-white disabled:opacity-50"
        >
          登入
        </button>
        {error && <p role="alert" className="text-[13px] text-[#c24f4a]">{error}</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-5">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-[18px] font-bold">收款账号</h1>
          <p className="mt-1 text-[12px] text-[#798697]">
            人工渠道加价：{markupPercent}% · 改完点「保存」即时生效
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            setChannels((prev) => [
              ...prev,
              { id: `channel-${prev.length + 1}`, label: "新渠道", account: "", enabled: false },
            ])
          }
          className="h-9 rounded-lg border border-[#d8dde3] bg-white px-3 text-[13px]"
        >
          + 添加渠道
        </button>
      </div>

      <div className="grid gap-4">
        {channels.map((channel, index) => (
          <section key={index} className="rounded-2xl border border-[#e1e7ee] bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <input
                value={channel.label}
                onChange={(event) => patch(index, { label: event.target.value })}
                placeholder="渠道名（如 支付宝）"
                className="h-10 flex-1 rounded-lg border border-[#d8dde3] px-3 text-[14px] font-semibold"
              />
              <label className="flex items-center gap-1.5 text-[13px] text-[#60646c]">
                <input
                  type="checkbox"
                  checked={channel.enabled}
                  onChange={(event) => patch(index, { enabled: event.target.checked })}
                />
                启用
              </label>
              <button
                type="button"
                onClick={() => setChannels((prev) => prev.filter((_, i) => i !== index))}
                className="text-[13px] text-[#c24f4a]"
              >
                删除
              </button>
            </div>

            <input
              value={channel.id}
              disabled
              className="mt-2 h-8 w-40 rounded-md bg-[#f5f7fa] px-2 text-[12px] text-[#8d99a8]"
            />

            <input
              value={channel.account}
              onChange={(event) => patch(index, { account: event.target.value })}
              placeholder="收款账号（手机号 / 邮箱 / 微信号）"
              className="mt-2 h-10 w-full rounded-lg border border-[#d8dde3] px-3 text-[14px]"
            />

            <div className="mt-2 flex items-start gap-3">
              {channel.qrImage ? (
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={channel.qrImage} alt="收款码" className="h-28 w-28 rounded-lg border border-[#e1e7ee] object-contain" />
                  <button
                    type="button"
                    onClick={() => patch(index, { qrImage: undefined })}
                    className="absolute -right-2 -top-2 h-6 w-6 rounded-full bg-[#1c2024] text-[12px] text-white"
                    aria-label="移除收款码"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div className="flex h-28 w-28 items-center justify-center rounded-lg border border-dashed border-[#c9d1d9] text-[12px] text-[#a2acb8]">
                  无收款码
                </div>
              )}
              <div className="flex-1">
                <button
                  type="button"
                  onClick={() => {
                    uploadTarget.current = index;
                    fileInput.current?.click();
                  }}
                  className="h-9 rounded-lg border border-[#d8dde3] bg-white px-3 text-[13px]"
                >
                  上传收款码
                </button>
                <p className="mt-2 text-[12px] leading-relaxed text-[#a2acb8]">
                  图片会自动压缩到 640px。客户在订单页能看到这张码。
                </p>
              </div>
            </div>

            <textarea
              value={channel.instructions ?? ""}
              onChange={(event) => patch(index, { instructions: event.target.value })}
              placeholder="转账说明（可选，如：转账请备注订单号）"
              rows={2}
              className="mt-2 w-full rounded-lg border border-[#d8dde3] p-2 text-[13px]"
            />
          </section>
        ))}
      </div>

      <div className="sticky bottom-3 mt-5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save(channels)}
          className="h-12 w-full rounded-xl bg-[#1c5f45] text-[15px] font-semibold text-white shadow-lg disabled:opacity-50"
        >
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
      {status && <p className="mt-2 text-[13px] text-[#1c5f45]">{status}</p>}
      {error && <p role="alert" className="mt-2 text-[13px] text-[#c24f4a]">{error}</p>}

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickImage}
      />
    </main>
  );
}
