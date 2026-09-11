/**
 * 公开目录适配器的解析测试。
 *
 * 上游把整个商品对象内联在详情页的一句 `setVar("_var_item", {...})` 里，
 * 而商品描述是富文本，里面既有大括号也有转义引号。用正则取这个对象一定会错：
 * 非贪婪在第一个 `}` 处截断，贪婪会吞掉后面的脚本。所以必须按括号配对扫描，
 * 并且跳过字符串字面量内部 —— 这些用例就是钉这件事的。
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { extractInlineJson } from "./public";

const MARKER = 'setVar("_var_item",';

describe("内联 JSON 提取", () => {
  test("普通对象", () => {
    const html = `<script>${MARKER}{"id":1,"name":"A"});</script>`;
    assert.deepEqual(extractInlineJson(html, MARKER), { id: 1, name: "A" });
  });

  test("嵌套对象不会在第一个 } 处截断", () => {
    const html = `${MARKER}{"id":1,"config":{"category":{"月卡":"48"}},"price":9});`;
    const parsed = extractInlineJson(html, MARKER) as Record<string, unknown>;
    assert.equal(parsed.price, 9);
    assert.deepEqual(parsed.config, { category: { 月卡: "48" } });
  });

  test("字符串里的大括号不影响配对", () => {
    // 商品描述里出现 } 是很常见的（模板片段、代码示例）。
    const html = `${MARKER}{"desc":"用法 {code} 结束}","id":7});`;
    const parsed = extractInlineJson(html, MARKER) as Record<string, unknown>;
    assert.equal(parsed.id, 7);
    assert.equal(parsed.desc, "用法 {code} 结束}");
  });

  test("转义引号不会被误判为字符串结束", () => {
    const html = `${MARKER}{"desc":"他说\\"你好\\"}","id":8});`;
    const parsed = extractInlineJson(html, MARKER) as Record<string, unknown>;
    assert.equal(parsed.id, 8);
  });

  test("对象后面还有别的脚本时只取这一个对象", () => {
    const html = `${MARKER}{"id":3});\nsetVar("other",{"id":99});`;
    const parsed = extractInlineJson(html, MARKER) as Record<string, unknown>;
    assert.equal(parsed.id, 3);
  });

  test("标记不存在时返回 null 而不是抛错", () => {
    assert.equal(extractInlineJson("<html></html>", MARKER), null);
  });

  test("括号不闭合时返回 null（页面被截断的情况）", () => {
    assert.equal(extractInlineJson(`${MARKER}{"id":1,`, MARKER), null);
  });

  test("JSON 非法时返回 null 而不是抛错", () => {
    // 单个商品解析失败不该中断整次目录同步。
    assert.equal(extractInlineJson(`${MARKER}{id:1});`, MARKER), null);
  });

  test("中文与 Unicode 转义都能正确解出", () => {
    const html = `${MARKER}{"name":"GPT PLUS\\u3010官方直充\\u3011","id":51});`;
    const parsed = extractInlineJson(html, MARKER) as Record<string, unknown>;
    assert.equal(parsed.name, "GPT PLUS【官方直充】");
  });
});

describe("真实页面结构（取自上游详情页的形状）", () => {
  test("能解出多规格的售价表与代理价表", () => {
    const html = `
      <script>
      ${MARKER}{"id":51,"name":"GPT PLUS","price":116,"delivery_way":0,
        "cover":"https://img.example/a.png","category_id":12,
        "tags":"官方充值,畅销","stock":"库存爆棚","is_stock":true,
        "config":{
          "category":{"渠道1:质保开通卡密":"116","渠道1:质保全程卡密":"118"},
          "category_agent_price":{"渠道1:质保开通卡密":"114.00","渠道1:质保全程卡密":"114.00"}
        }});
      </script>`;

    const parsed = extractInlineJson(html, MARKER) as Record<string, unknown>;
    const config = parsed.config as Record<string, Record<string, string>>;

    assert.equal(parsed.id, 51);
    assert.equal(config.category?.["渠道1:质保开通卡密"], "116");
    // 代理价低于零售价 —— 成本口径选 agent 时用的就是这一列。
    assert.equal(config.category_agent_price?.["渠道1:质保开通卡密"], "114.00");
  });
});
