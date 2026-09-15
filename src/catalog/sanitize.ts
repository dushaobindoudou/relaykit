/**
 * 上游商品富文本的白名单清洗。
 *
 * 上游的详情是 CKEditor 系的产物：大量内联 style、font 标签、旧式属性，
 * 直接塞进 Dawn 主题会毁掉排版，也是潜在的脚本注入面。这里的做法是
 * **结构保留、表现全剥**：段落/列表/表格/图片/链接活着进来，
 * 一切表现属性死在门口，视觉由 .rte 主题接管。
 *
 * 为什么不用 DOMPurify：它依赖 DOM API，Workers 里没有；
 * 引 sanitize-html 则带进一棵依赖树。商品描述的标签集合是已知的小集合，
 * 一个百余行的状态机扫描器更可控、也更容易被穷举测试。
 *
 * 实现是一个极简标签扫描器：不出 DOM 树，只做「白名单内保留、
 * 白名单外转义」。嵌套错误的 HTML 会保持原样的错误嵌套 ——
 * 浏览器对错误嵌套有既定的容错规则，我们不去"修复"它。
 */

/** 保留结构的标签。属性一律剥光，除了链接与图片的少数安全属性。 */
const STRUCTURAL_TAGS = new Set([
  "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "img", "a",
  "video", "source",
  "strong", "b", "em", "i", "u", "s", "del", "sub", "sup", "mark",
  "figure", "figcaption",
]);

/**
 * 剥成纯文本容器的标签。font 是编辑器遗留；span/div 在富文本里只承担
 * 表现职责，保留它们只会让上游的碎片样式进来。
 */
const UNWRAP_TAGS = new Set(["font", "span", "div", "section", "article", "main"]);

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value, "https://placeholder.invalid");
    // 相对路径（图片、站内锚点）放行；协议白名单外的（javascript: 等）丢弃。
    if (value.startsWith("/") || value.startsWith("#")) return url.toString().replace("https://placeholder.invalid", "");
    if (ALLOWED_PROTOCOLS.has(url.protocol)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 处理一个开标签（或自闭合标签），返回安全 HTML 或空串。 */
function openTag(tag: string, rawAttrs: string, selfClosing: boolean): string {
  if (UNWRAP_TAGS.has(tag)) return "";

  if (tag === "a") {
    const href = attrValue(rawAttrs, "href");
    const safe = href ? safeUrl(href) : null;
    if (!safe) {
      // 没有安全 href 的链接退化为纯文本，不保留死链接。
      return "";
    }
    return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow">`;
  }

  if (tag === "video" || tag === "source") {
    const src = attrValue(rawAttrs, "src");
    const safe = src ? safeUrl(src) : null;
    if (tag === "source" && !safe) return "";
    if (tag === "video") {
      // 无安全来源的视频壳照样保留（source 子标签会兜底），但 poster 必须安全。
      const poster = attrValue(rawAttrs, "poster");
      const safePoster = poster ? safeUrl(poster) : null;
      const attrs = [` src="${safe ? escapeHtml(safe) : ""}"`, " controls"];
      if (safePoster) attrs.push(` poster="${escapeHtml(safePoster)}"`);
      return `<video${attrs.join("")}>`;
    }
    return `<source src="${escapeHtml(safe ?? "")}" type="video/mp4">`;
  }

  if (tag === "img") {
    const src = attrValue(rawAttrs, "src");
    const safe = src ? safeUrl(src) : null;
    if (!safe) return "";
    const alt = attrValue(rawAttrs, "alt") ?? "";
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}"${selfClosing ? " /" : ""}>`;
  }

  if (!STRUCTURAL_TAGS.has(tag)) return "";
  return `<${tag}${selfClosing ? " /" : ""}>`;
}

/** 从原始属性串里取一个属性的值。只支持平凡的 key="value" 形态。 */
function attrValue(rawAttrs: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = rawAttrs.match(pattern);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? "";
}

/**
 * 清洗一段富文本。
 * 结构标签保留、表现属性剥光、白名单外标签转义、font/span/div 拆掉壳。
 */
export function sanitizeDescription(html: string): string {
  let out = "";
  let i = 0;

  while (i < html.length) {
    const next = html.indexOf("<", i);
    if (next === -1) {
      out += escapeHtml(html.slice(i));
      break;
    }

    out += escapeHtml(html.slice(i, next));

    const end = html.indexOf(">", next);
    if (end === -1) {
      // 悬空的 "<"：当文本处理。
      out += escapeHtml(html.slice(next));
      break;
    }

    const tagText = html.slice(next + 1, end);

    // 注释整个丢弃。
    if (tagText.startsWith("!--")) {
      i = end + 1;
      continue;
    }

    // 闭合标签。
    if (tagText.startsWith("/")) {
      const name = tagText.slice(1).trim().toLowerCase();
      // 只有结构标签输出闭合；unwrap 标签连壳一起消失（开标签没输出，
      // 闭合也不输出）；a/img 的开标签可能因无安全 href/src 被丢弃，
      // 孤立的闭合标签会破坏结构，同样不输出。
      if (STRUCTURAL_TAGS.has(name) && name !== "a" && name !== "img") {
        out += `</${name}>`;
      }
      i = end + 1;
      continue;
    }

    // doctype / 处理指令等：丢弃。
    if (tagText.startsWith("!") || tagText.startsWith("?")) {
      i = end + 1;
      continue;
    }

    const selfClosing = tagText.endsWith("/");
    const body = selfClosing ? tagText.slice(0, -1) : tagText;
    const spaceAt = body.search(/[\s/]/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const attrs = spaceAt === -1 ? "" : body.slice(spaceAt);

    // script/style/iframe 里的内容必须整体丢弃，不只是标签本身 ——
    // 只转义标签会把代码当正文显示出来。
    if (name === "script" || name === "style" || name === "iframe" || name === "object" || name === "embed") {
      const close = new RegExp(`</${name}\\s*>`, "i");
      const rest = html.slice(end + 1);
      const match = rest.match(close);
      i = match ? end + 1 + (match.index ?? 0) + match[0].length : html.length;
      continue;
    }

    out += openTag(name, attrs, selfClosing);
    i = end + 1;
  }

  return out.trim();
}
