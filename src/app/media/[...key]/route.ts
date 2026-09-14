/**
 * 媒体读取路由：GET /media/<key> → R2 对象。
 *
 * 键名不可枚举地映射到 bucket，路径只进不出的白名单校验在 isValidMediaKey；
 * 命中后下发一年期 immutable 缓存 —— 对象键包含内容语义（商品 code、序号），
 * 更新图片 = 同步脚本上传新文件并更新 DB 里的 URL，旧 URL 永不变内容。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { isValidMediaKey } from "@/media/keys";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key: parts } = await params;
  const key = parts.join("/");

  if (!isValidMediaKey(key)) {
    return new Response("invalid media key", { status: 400 });
  }

  const { env } = getCloudflareContext();
  const bucket = (env as { MEDIA?: R2Bucket }).MEDIA;
  if (!bucket) {
    // binding 没配（旧部署/未建桶）时明确报错，而不是当作 404 让图永远挂着。
    return new Response("media storage not configured", { status: 503 });
  }

  const object = await bucket.get(key);
  if (!object) return new Response(null, { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
