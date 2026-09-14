/**
 * 媒体键名与目录改写的单元测试。
 *
 * 这些纯函数是「写入端路由」与「同步脚本」共享的唯一规则源，
 * 键名规则一旦分叉，R2 里就会出现永远清理不掉的孤儿对象。
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  applyImageRewrites,
  extractDescriptionImages,
  isAllowedContentType,
  isRemoteImage,
  isValidMediaKey,
  planCatalogImages,
  productCoverKey,
  replaceDescriptionImage,
  slugSegment,
  type MediaRewritable,
} from "./keys";

describe("isValidMediaKey", () => {
  test("合法键：单层、多层、带点划线", () => {
    for (const key of [
      "covers/123.webp",
      "categories/3.webp",
      "covers/12/desc-0.webp",
      "a.webp",
      "covers/brand-mark-v2.webp",
    ]) {
      assert.equal(isValidMediaKey(key), true, key);
    }
  });

  test("非法键：目录穿越、大写、空段、特殊字符", () => {
    for (const key of [
      "",
      "../etc/passwd",
      "covers/.hidden",
      "covers//x.webp",
      "Cover/1.webp",
      "covers/1.webp/",
      "/absolute.webp",
      "covers/x y.webp",
      "a".repeat(201),
    ]) {
      assert.equal(isValidMediaKey(key), false, key);
    }
  });
});

describe("slugSegment", () => {
  test("数字 id 原样保留，符号压成连字符", () => {
    assert.equal(slugSegment("178860"), "178860");
    assert.equal(slugSegment("ABC_123"), "abc-123");
    assert.equal(slugSegment("  "), "x");
  });
});

describe("内容类型闸门", () => {
  test("常见图片类型放行，伪装类型拒绝", () => {
    assert.equal(isAllowedContentType("image/webp"), true);
    assert.equal(isAllowedContentType("image/png"), true);
    assert.equal(isAllowedContentType("text/html"), false);
    assert.equal(isAllowedContentType("application/json"), false);
  });
});

describe("描述图片抽取与替换", () => {
  const html =
    '<p><img src="https://img.example/a.png" alt="x"></p><img src="//img.example/b.jpg">';

  test("抽出全部 src（含协议相对）", () => {
    assert.deepEqual(extractDescriptionImages(html), [
      "https://img.example/a.png",
      "//img.example/b.jpg",
    ]);
  });

  test("原文替换只动目标 URL", () => {
    const rewritten = replaceDescriptionImage(
      html,
      "https://img.example/a.png",
      "/media/covers/a.webp",
    );
    assert.equal(rewritten.includes("/media/covers/a.webp"), true);
    assert.equal(rewritten.includes("//img.example/b.jpg"), true);
  });
});

describe("isRemoteImage", () => {
  test("绝对与协议相对是上游图，站点相对不是", () => {
    assert.equal(isRemoteImage("https://x/y.png"), true);
    assert.equal(isRemoteImage("//x/y.png"), true);
    assert.equal(isRemoteImage("/media/covers/x.webp"), false);
  });
});

describe("planCatalogImages + applyImageRewrites", () => {
  test("生成计划 → 只应用成功子集 → 失败项保留上游 URL", () => {
    const products: MediaRewritable[] = [
      {
        code: "178860",
        cover: "https://imgurloss.xqd.cn/a.png",
        description:
          '<img src="https://imgurloss.xqd.cn/b.png"><img src="/media/already.webp">',
      },
      { code: "178861" },
    ];
    const categories = [
      { id: "3", icon: "https://imgurloss.xqd.cn/cat.png" },
      { id: "4", icon: "/media/local.webp" },
    ];

    const { plan } = planCatalogImages(products, categories);
    assert.equal(plan.size, 3); // cover + 描述图 + 分类图标
    assert.equal(plan.has("https://imgurloss.xqd.cn/a.png"), true);
    assert.equal(plan.get("https://imgurloss.xqd.cn/a.png"), "/media/covers/178860.webp");
    assert.equal(
      plan.get("https://imgurloss.xqd.cn/b.png"),
      "/media/covers/178860/desc-0.webp",
    );
    assert.equal(plan.get("https://imgurloss.xqd.cn/cat.png"), "/media/categories/3.webp");

    // 只有一张图上传成功。
    const urlMap = new Map([["https://imgurloss.xqd.cn/a.png", "/media/covers/178860.webp"]]);
    applyImageRewrites(products, categories, urlMap);

    assert.equal(products[0]!.cover, "/media/covers/178860.webp");
    // 描述图没传成功 → 原样保留。
    assert.equal(products[0]!.description!.includes("imgurloss.xqd.cn/b.png"), true);
    assert.equal(products[0]!.description!.includes("/media/already.webp"), true);
    // 分类图标不在成功子集 → 保留。
    assert.equal(categories[0]!.icon, "https://imgurloss.xqd.cn/cat.png");
    // 本来就是站点相对的 icon 不进计划也不被改。
    assert.equal(categories[1]!.icon, "/media/local.webp");
  });

  test("协议相对 URL 归一化后能命中改写", () => {
    const products = [{ code: "9", cover: "//imgurloss.xqd.cn/c.png" }];
    const { plan } = planCatalogImages(products, []);
    assert.equal(plan.has("https://imgurloss.xqd.cn/c.png"), true);
    applyImageRewrites(products, [], plan);
    assert.equal(products[0]!.cover, "/media/covers/9.webp");
  });

  test("商品封面键稳定且合法", () => {
    const key = productCoverKey("178860");
    assert.equal(isValidMediaKey(key), true);
    assert.equal(key, "covers/178860.webp");
  });
});
