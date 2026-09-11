import { describe, expect, it } from "vitest";

import { sanitizeDescription } from "@/catalog/sanitize";

describe("sanitizeDescription", () => {
  it("保留结构标签，剥光表现属性", () => {
    const input = `<p style="color:red" align="center">你好</p><h2 class="big">标题</h2>`;
    expect(sanitizeDescription(input)).toBe(`<p>你好</p><h2>标题</h2>`);
  });

  it("font 标签整体拆壳，只留文字", () => {
    const input = `<font color="#c24f4a" size="3">警告</font>`;
    expect(sanitizeDescription(input)).toBe(`警告`);
  });

  it("span/div 拆壳但保留内部结构", () => {
    const input = `<div style="margin:0"><span>内文</span>，后续</div>`;
    expect(sanitizeDescription(input)).toBe(`内文，后续`);
  });

  it("链接保留安全 href，附加 rel 防钓鱼", () => {
    const input = `<a href="https://example.com/x" target="_blank" onclick="steal()">点我</a>`;
    const out = sanitizeDescription(input);
    expect(out).toContain(`href="https://example.com/x"`);
    expect(out).toContain(`rel="noopener noreferrer nofollow"`);
    expect(out).not.toContain("target");
    expect(out).not.toContain("onclick");
  });

  it("javascript: 链接退化为纯文本，孤立闭合标签不残留", () => {
    const input = `<a href="javascript:alert(1)">点我</a>`;
    expect(sanitizeDescription(input)).toBe(`点我`);
  });

  it("图片保留安全 src 与 alt，剥掉其余属性", () => {
    const input = `<img src="https://img.example.com/a.png" alt="商品图" style="width:100%" onerror="boom()">`;
    const out = sanitizeDescription(input);
    expect(out).toContain(`src="https://img.example.com/a.png"`);
    expect(out).toContain(`alt="商品图"`);
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("style");
  });

  it("script 内容整体丢弃，不只是标签", () => {
    const input = `<p>前</p><script>alert("xss")</script><p>后</p>`;
    expect(sanitizeDescription(input)).toBe(`<p>前</p><p>后</p>`);
  });

  it("style 块整体丢弃", () => {
    const input = `<style>body{display:none}</style><p>正文</p>`;
    expect(sanitizeDescription(input)).toBe(`<p>正文</p>`);
  });

  it("未知标签整体丢弃，只留内容", () => {
    const input = `<marquee>滚动</marquee>`;
    expect(sanitizeDescription(input)).toBe(`滚动`);
  });

  it("列表与表格结构完整保留", () => {
    const input = `<ul><li>一</li><li>二</li></ul><table><tr><td width="50">格</td></tr></table>`;
    expect(sanitizeDescription(input)).toBe(
      `<ul><li>一</li><li>二</li></ul><table><tr><td>格</td></tr></table>`,
    );
  });

  it("纯文本与实体不受影响（文本被转义是预期：上游正文不含裸实体）", () => {
    expect(sanitizeDescription("普通文字")).toBe("普通文字");
  });

  it("上游真实样本：内联样式与嵌套 font 全部剥离", () => {
    const input =
      `<h2><font color="#4d80bf"><font style="vertical-align:inherit;">🛑 重要（必读）</font></font></h2>` +
      `<ul><li><h3><font color="#c24f4a">1.账号获取方式</font></h3></li></ul>`;
    expect(sanitizeDescription(input)).toBe(
      `<h2>🛑 重要（必读）</h2><ul><li><h3>1.账号获取方式</h3></li></ul>`,
    );
  });

  it("悬空的尖括号当文本处理", () => {
    expect(sanitizeDescription("a < b")).toBe("a &lt; b");
  });

  it("相对路径图片放行", () => {
    const input = `<img src="/assets/a.png">`;
    expect(sanitizeDescription(input)).toBe(`<img src="/assets/a.png" alt="">`);
  });
});
