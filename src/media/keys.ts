/**
 * 媒体对象命名与目录改写的纯函数。
 *
 * 同步脚本把上游图片下载压缩后推进 R2，键名就是这里生成的；店面引用的
 * URL 一律是站点相对路径 `/media/<key>`。放在 src 而不是脚本里，是为了
 * 让校验规则在「写入端」（admin/media 路由）与「生产端」（同步脚本）之间
 * 共享同一份 —— 键名规则分叉会导致清理脚本永远对不上号。
 */

/** R2 对象键的允许形态：小写字母数字开头，段内小写字母数字._-，可分层。 */
export const MEDIA_KEY_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** 键总长上限。R2 上限 1024 字节，这里收紧到留出头部余量。 */
export const MEDIA_KEY_MAX_LENGTH = 200;

export function isValidMediaKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= MEDIA_KEY_MAX_LENGTH &&
    MEDIA_KEY_PATTERN.test(key)
  );
}

/**
 * 把任意上游标识（商品 code、分类 id）压成键名安全段。
 * 上游 id 通常是纯数字，但别赌 —— 统一过一遍 slug。
 */
export function slugSegment(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  // 全是符号的 id（理论上是坏数据）给个确定性的占位，保证键合法。
  return slug || "x";
}

export function productCoverKey(productCode: string): string {
  return `covers/${slugSegment(productCode)}.webp`;
}

export function categoryIconKey(categoryId: string): string {
  return `categories/${slugSegment(categoryId)}.webp`;
}

export function descriptionImageKey(
  productCode: string,
  index: number,
): string {
  return `covers/${slugSegment(productCode)}/desc-${index}.webp`;
}

/** 允许入库的图片类型 → 扩展名。键里的扩展名必须与之匹配，防内容类型伪装。 */
const ALLOWED_TYPES: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

export function extensionForContentType(contentType: string): string | null {
  const base = (contentType.split(";")[0] ?? contentType).trim().toLowerCase();
  return ALLOWED_TYPES[base] ?? null;
}

export function isAllowedContentType(contentType: string): boolean {
  return extensionForContentType(contentType) !== null;
}

export interface MediaRewritable {
  /** 上游商品标识，决定封面/描述图的键名。分类没有这个字段。 */
  code?: string;
  cover?: string;
  description?: string;
}

export interface CatalogCategoryLike {
  id: string;
  icon?: string;
}

/** 从富文本描述里抽 <img src>。sanitize 只保留 http(s) 与站点相对地址。 */
export function extractDescriptionImages(description: string): string[] {
  const found: string[] = [];
  const pattern = /<img\b[^>]*?src=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(description)) !== null) {
    const source = match[1];
    if (source) found.push(source);
  }
  return found;
}

export function replaceDescriptionImage(
  description: string,
  original: string,
  replacement: string,
): string {
  // src 值在 HTML 属性里出现，原文替换即可；split/join 避开正则转义问题。
  return description.split(original).join(replacement);
}

/** 绝对 http(s) 或协议相对地址才算「上游图」，站点相对路径不动。 */
export function isRemoteImage(url: string): boolean {
  return /^https?:\/\//.test(url) || url.startsWith("//");
}

export function normalizeRemoteImage(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}

export interface RewriteResult {
  /** 原始 URL → 站点相对路径 的改写登记表，供脚本逐条上传。 */
  plan: Map<string, string>;
  products: MediaRewritable[];
  categories: CatalogCategoryLike[];
}

/**
 * 生成整份目录的图片改写计划。
 *
 * 不在上传前就改写：脚本拿 plan 逐个下载/压缩/上传，成功的才进
 * urlMap，最后用「只有成功条目的 urlMap」做真正的替换 —— 任何一张图
 * 失败都原地保留上游 URL，绝不让商品因为配图失败而下架。
 */
export function planCatalogImages(
  products: MediaRewritable[],
  categories: CatalogCategoryLike[],
): RewriteResult {
  const plan = new Map<string, string>();

  for (const category of categories) {
    if (category.icon && isRemoteImage(category.icon)) {
      plan.set(
        normalizeRemoteImage(category.icon),
        `/media/${categoryIconKey(category.id)}`,
      );
    }
  }

  for (const product of products) {
    const code = product.code ?? "";
    if (product.cover && isRemoteImage(product.cover)) {
      plan.set(
        normalizeRemoteImage(product.cover),
        `/media/${productCoverKey(code)}`,
      );
    }
    if (product.description) {
      for (const [index, image] of extractDescriptionImages(
        product.description,
      ).entries()) {
        if (isRemoteImage(image)) {
          plan.set(
            normalizeRemoteImage(image),
            `/media/${descriptionImageKey(code, index)}`,
          );
        }
      }
    }
  }

  return { plan, products, categories };
}

/** 上传完成后，用「成功子集」真正改写目录字段。 */
export function applyImageRewrites(
  products: MediaRewritable[],
  categories: CatalogCategoryLike[],
  urlMap: Map<string, string>,
): void {
  const rewrite = (url: string): string =>
    urlMap.get(url) ??
    urlMap.get(normalizeRemoteImage(url)) ??
    url;

  for (const category of categories) {
    if (category.icon) category.icon = rewrite(category.icon);
  }
  for (const product of products) {
    if (product.cover) product.cover = rewrite(product.cover);
    if (product.description) {
      for (const image of extractDescriptionImages(product.description)) {
        const mapped = rewrite(image);
        if (mapped !== image) {
          product.description = replaceDescriptionImage(
            product.description,
            image,
            mapped,
          );
        }
      }
    }
  }
}
