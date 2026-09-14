/**
 * 媒体上传端点：POST /api/admin/media（multipart/form-data）。
 *
 * 只给同步脚本用：它在上游可达的主机上把商品图下载、压缩成 webp，
 * 随目录数据一起推进站点。Worker 收到后直接写 R2 —— Workers 里没有
 * sharp，所以压缩必须发生在脚本端，这里只做闸门：
 *
 * - ADMIN_TOKEN 保护（与其他 /api/admin/* 一致）
 * - 键名白名单（isValidMediaKey），扩展名与内容类型必须互相印证
 * - 单文件 ≤ 5MiB，单次 ≤ 60 个（R2 单对象上限远大于此，收紧是防滥用）
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  extensionForContentType,
  isAllowedContentType,
  isValidMediaKey,
} from "@/media/keys";
import type { Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

const MAX_FILES = 60;
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const bindings: Bindings = env;

  const expected = bindings.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected === "") {
    return Response.json(
      { ok: false, error: "未设置 ADMIN_TOKEN，拒绝执行。请先 `wrangler secret put ADMIN_TOKEN`。" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const bucket = (bindings as { MEDIA?: R2Bucket }).MEDIA;
  if (!bucket) {
    return Response.json(
      { ok: false, error: "未配置 MEDIA 绑定。请在 wrangler.jsonc 配置 r2_buckets 并 `wrangler r2 bucket create relaykit-media`。" },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { ok: false, error: "请求必须是 multipart/form-data" },
      { status: 400 },
    );
  }

  const files = form.getAll("file").filter((item): item is File => item instanceof File);
  if (files.length === 0) {
    return Response.json({ ok: false, error: "没有名为 file 的文件字段" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return Response.json(
      { ok: false, error: `单次最多 ${MAX_FILES} 个文件` },
      { status: 413 },
    );
  }

  const uploaded: { key: string; path: string }[] = [];
  const failed: { filename: string; reason: string }[] = [];

  for (const file of files) {
    const key = file.name;
    if (!isValidMediaKey(key)) {
      failed.push({ filename: key, reason: "键名不合法" });
      continue;
    }
    // 类型以 HTTP 头为准，但扩展名要对得上 —— 只改 Content-Type 头
    // 塞进来的东西在键名这关就已经过不去了，这里再拦一道伪装。
    if (!isAllowedContentType(file.type)) {
      failed.push({ filename: key, reason: `不支持的类型 ${file.type}` });
      continue;
    }
    const expectedExt = extensionForContentType(file.type);
    if (!expectedExt || !key.endsWith(`.${expectedExt}`)) {
      failed.push({ filename: key, reason: "扩展名与内容类型不符" });
      continue;
    }
    if (file.size > MAX_BYTES) {
      failed.push({ filename: key, reason: "超过 5MiB 上限" });
      continue;
    }

    try {
      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
      });
      uploaded.push({ key, path: `/media/${key}` });
    } catch (error) {
      failed.push({
        filename: key,
        reason: error instanceof Error ? error.message : "写入失败",
      });
    }
  }

  // 部分成功也算 ok：调用方（同步脚本）按 uploaded 登记改写 URL，
  // failed 的图保留上游地址，目录照常落库。
  return Response.json({ ok: true, uploaded, failed });
}
