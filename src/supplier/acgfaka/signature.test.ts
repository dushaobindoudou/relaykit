/**
 * 这些用例钉的是 PHP 侧 generateSignature 的语义，不是"我们希望它怎么算"。
 * 每个 assert 上面标注了它对应 PHP 的哪一行行为；如果哪天上游回 "密钥错误"，
 * 先看 buildSignBase 的输出，再回到这里核对是哪条语义没对上。
 *
 * 本地没有 PHP/Docker 可以生成权威向量，所以下面的期望值是按语义推导出来的。
 * 拿到 app_id / app_key 后第一件事应当是用真实凭据打一次 connect：
 * 上游 SharedValidation 先查 app_id 再验签，所以
 *   - "商户ID不存在" = app_id 错，签名还没被校验到
 *   - "密钥错误"     = app_id 对、签名错 ← 说明这个文件里有一条语义推错了
 *   - 200            = 全对
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, describe } from "node:test";

import { buildSignBase, generateSignature, signedForm } from "./signature.ts";

const md5 = (input: string): string =>
  createHash("md5").update(input, "utf8").digest("hex");

describe("buildSignBase", () => {
  test("按键的字节序排序，并在末尾拼上 &key=appKey（ksort + 拼接）", () => {
    const base = buildSignBase({ num: 1, app_id: 42, contact: "a@b.com" }, "SECRET");
    assert.equal(base, "app_id=42&contact=a@b.com&num=1&key=SECRET");
  });

  test("剔除 sign 自身（unset($data['sign'])）", () => {
    const base = buildSignBase({ app_id: 1, sign: "whatever" }, "K");
    assert.equal(base, "app_id=1&key=K");
  });

  test("顶层空字符串被剔除，不生成 'k=' 项（$val === '' 的 unset）", () => {
    const base = buildSignBase({ app_id: 1, race: "", contact: "x" }, "K");
    assert.equal(base, "app_id=1&contact=x&key=K");
  });

  test("null 被 http_build_query 整项跳过，与空串结果一致但成因不同", () => {
    const base = buildSignBase({ app_id: 1, card_id: null, num: 2 }, "K");
    assert.equal(base, "app_id=1&num=2&key=K");
  });

  test("0 和 '0' 都要保留 —— 它们不等于空串，漏掉会让 card_id=0 这类字段丢失", () => {
    const base = buildSignBase({ card_id: 0, device: "0", app_id: 1 }, "K");
    assert.equal(base, "app_id=1&card_id=0&device=0&key=K");
  });

  test("bool 走 int 口径：true→1、false→0（false 不是空串，不能消失）", () => {
    const base = buildSignBase({ a: true, b: false }, "K");
    assert.equal(base, "a=1&b=0&key=K");
  });

  test("嵌套一层展开成 k[sub]=v，且子键保持插入序（ksort 只管顶层）", () => {
    const base = buildSignBase({ sku: { z: "1", a: "2" }, app_id: 9 }, "K");
    assert.equal(base, "app_id=9&sku[z]=1&sku[a]=2&key=K");
  });

  test("嵌套内的空串**保留**，只有顶层才被 unset", () => {
    const base = buildSignBase({ sku: { a: "" } }, "K");
    assert.equal(base, "sku[a]=&key=K");
  });

  test("值里的空格经 urlencode→urldecode 往返后仍是空格（恒等变换）", () => {
    const base = buildSignBase({ note: "hello world" }, "K");
    assert.equal(base, "note=hello world&key=K");
  });

  test("值里的 + 和 % 同样往返不变", () => {
    const base = buildSignBase({ note: "a+b 100%" }, "K");
    assert.equal(base, "note=a+b 100%&key=K");
  });

  test("中文值按 UTF-8 原样进入明文（md5 对字节，不是对码位）", () => {
    const base = buildSignBase({ race: "渠道1:质保开通卡密" }, "K");
    assert.equal(base, "race=渠道1:质保开通卡密&key=K");
  });

  test("appKey 未经编码却被一起 urldecode：'+' 会塌成空格（PHP 既有行为，照抄）", () => {
    // 若把 appKey 当作不可变字符串直接参与 md5，这里会算出不同的签名。
    assert.equal(buildSignBase({ a: 1 }, "k+y"), "a=1&key=k y");
  });

  test("appKey 里的 %XX 也会被解码（同上，非笔误）", () => {
    assert.equal(buildSignBase({ a: 1 }, "k%41y"), "a=1&key=kAy");
  });

  test("落单的 % 不抛异常、原样保留（PHP urldecode 的容错，decodeURIComponent 会抛）", () => {
    assert.doesNotThrow(() => buildSignBase({ note: "50% off" }, "K"));
    assert.equal(buildSignBase({ note: "50% off" }, "K"), "note=50% off&key=K");
  });
});

describe("generateSignature", () => {
  test("就是 buildSignBase 输出的 md5，没有额外加盐", () => {
    const payload = { app_id: 42, shared_code: "063C2186C0B42343", num: 1 };
    assert.equal(
      generateSignature(payload, "SECRET"),
      md5("app_id=42&num=1&shared_code=063C2186C0B42343&key=SECRET"),
    );
  });

  test("字段顺序不影响结果（ksort 之后才签）", () => {
    const key = "SECRET";
    assert.equal(
      generateSignature({ b: 2, a: 1 }, key),
      generateSignature({ a: 1, b: 2 }, key),
    );
  });

  test("传入的 sign 不影响结果（幂等重签安全）", () => {
    const key = "SECRET";
    const once = generateSignature({ a: 1 }, key);
    assert.equal(generateSignature({ a: 1, sign: once }, key), once);
  });
});

describe("signedForm", () => {
  test("表单里带 sign，且与 generateSignature 一致", () => {
    const payload = { app_id: 42, num: 1 };
    const form = signedForm(payload, "SECRET");
    assert.equal(form.get("sign"), generateSignature(payload, "SECRET"));
    assert.equal(form.get("app_id"), "42");
  });

  test("嵌套 sku 按 sku[k] 的字段名发送，与签名时的展开方式一致", () => {
    const form = signedForm({ sku: { color: "red" } }, "K");
    assert.equal(form.get("sku[color]"), "red");
  });

  test("被签名剔除的字段也不发送，避免上游收到未参与签名的字段", () => {
    const form = signedForm({ a: 1, empty: "", nothing: null }, "K");
    assert.equal(form.get("empty"), null);
    assert.equal(form.get("nothing"), null);
  });

  test("发送时重新编码，空格走 form-urlencoded 的 '+'（与签名明文不是同一个串）", () => {
    const form = signedForm({ note: "hello world" }, "K");
    assert.match(form.toString(), /note=hello\+world/);
  });
});
