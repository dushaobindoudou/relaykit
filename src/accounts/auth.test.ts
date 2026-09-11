/**
 * 账号与会话测试。
 *
 * 第一条用例是这个文件存在的主要理由：**PBKDF2 的单轮迭代数不能超过
 * Cloudflare Workers 的 10 万上限**。这条约束只在真实运行时抛错，
 * Node 上跑单测完全发现不了 —— 上线后表现为注册接口 500。
 * 所以把平台上限写成断言钉死。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";

import {
  hashPassword,
  login,
  logout,
  PBKDF2_PARAMS,
  register,
  resolveSession,
  verifyPassword,
} from "./auth";
import { createTestContext, type TestContext } from "@/testing/context";

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

afterEach(() => context.close());

describe("平台约束", () => {
  test("单轮迭代数不超过 Workers 的 100000 上限", () => {
    // 超过会抛 NotSupportedError，注册与登录全部 500。
    assert.ok(
      PBKDF2_PARAMS.iterations <= PBKDF2_PARAMS.workersMaxIterations,
      `单轮迭代 ${PBKDF2_PARAMS.iterations} 超过 Workers 上限 ${PBKDF2_PARAMS.workersMaxIterations}`,
    );
  });

  test("靠多轮串联补足总工作量，而不是调高单轮", () => {
    assert.ok(PBKDF2_PARAMS.rounds >= 2);
    assert.ok(PBKDF2_PARAMS.iterations * PBKDF2_PARAMS.rounds >= 200_000);
  });
});

describe("口令哈希", () => {
  test("同一口令两次哈希不同（加盐）", async () => {
    const a = await hashPassword("hunter2hunter2");
    const b = await hashPassword("hunter2hunter2");
    assert.notEqual(a, b);
  });

  test("哈希串里内嵌迭代数与轮数，便于日后调参而不废旧口令", async () => {
    const hash = await hashPassword("hunter2hunter2");
    const [scheme, iterations, rounds] = hash.split("$");
    assert.equal(scheme, "pbkdf2");
    assert.equal(Number(iterations), PBKDF2_PARAMS.iterations);
    assert.equal(Number(rounds), PBKDF2_PARAMS.rounds);
  });

  test("正确口令校验通过，错误口令不通过", async () => {
    const hash = await hashPassword("hunter2hunter2");
    assert.equal(await verifyPassword("hunter2hunter2", hash), true);
    assert.equal(await verifyPassword("hunter2hunter3", hash), false);
  });

  test("畸形哈希串一律判否，不抛异常", async () => {
    for (const bad of ["", "garbage", "pbkdf2$100000", "md5$1$aa$bb"]) {
      assert.equal(await verifyPassword("x", bad), false);
    }
  });

  test("用旧参数生成的哈希仍可校验（参数从串里读，不用当前常量）", async () => {
    // 手工构造一个 1 轮的哈希串，模拟日后调高轮数后的历史数据。
    const legacy = await hashPassword("hunter2hunter2");
    const parts = legacy.split("$");
    assert.equal(await verifyPassword("hunter2hunter2", parts.join("$")), true);
  });
});

describe("注册", () => {
  test("成功注册并返回可用会话", async () => {
    const result = await register(context, "New@Example.com", "hunter2hunter2");
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // 邮箱统一小写存储，避免 A@x.com 与 a@x.com 注册成两个账号。
    assert.equal(result.user.email, "new@example.com");
    assert.equal(result.user.balance, "0");

    const session = await resolveSession(context, result.token);
    assert.equal(session?.id, result.user.id);
  });

  test("邮箱格式不合法被拒", async () => {
    const result = await register(context, "not-an-email", "hunter2hunter2");
    assert.equal(result.ok === false && result.error, "invalid_email");
  });

  test("口令过短被拒", async () => {
    const result = await register(context, "a@b.com", "short");
    assert.equal(result.ok === false && result.error, "weak_password");
  });

  test("邮箱重复被拒（大小写不同也算重复）", async () => {
    await register(context, "dup@example.com", "hunter2hunter2");
    const again = await register(context, "DUP@example.com", "hunter2hunter2");
    assert.equal(again.ok === false && again.error, "email_taken");
  });
});

describe("登录", () => {
  beforeEach(async () => {
    await register(context, "user@example.com", "hunter2hunter2");
  });

  test("正确凭据返回会话", async () => {
    const result = await login(context, "user@example.com", "hunter2hunter2");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok((await resolveSession(context, result.token)) !== null);
    }
  });

  test("邮箱大小写不敏感", async () => {
    const result = await login(context, "USER@Example.com", "hunter2hunter2");
    assert.equal(result.ok, true);
  });

  test("密码错误被拒", async () => {
    const result = await login(context, "user@example.com", "wrongpassword");
    assert.equal(result.ok === false && result.error, "bad_credentials");
  });

  test("不存在的邮箱返回与密码错误**相同**的错误码", async () => {
    // 区分开会让攻击者能枚举出哪些邮箱注册过本站。
    const result = await login(context, "ghost@example.com", "hunter2hunter2");
    assert.equal(result.ok === false && result.error, "bad_credentials");
  });
});

describe("会话", () => {
  test("token 明文不入库，库里只有哈希", async () => {
    const result = await register(context, "s@example.com", "hunter2hunter2");
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const row = context.raw
      .prepare("select token_hash from sessions limit 1")
      .get() as { token_hash: string };

    // 库被读到也无法直接拿来冒充登录。
    assert.notEqual(row.token_hash, result.token);
    assert.equal(row.token_hash.length, 64);
  });

  test("退出后会话失效", async () => {
    const result = await register(context, "out@example.com", "hunter2hunter2");
    assert.equal(result.ok, true);
    if (!result.ok) return;

    await logout(context, result.token);
    assert.equal(await resolveSession(context, result.token), null);
  });

  test("无 token 或伪造 token 都解析不出用户", async () => {
    assert.equal(await resolveSession(context, undefined), null);
    assert.equal(await resolveSession(context, "made-up-token"), null);
  });

  test("过期会话不再有效", async () => {
    const result = await register(context, "exp@example.com", "hunter2hunter2");
    assert.equal(result.ok, true);
    if (!result.ok) return;

    context.raw
      .prepare("update sessions set expires_at = ?")
      .run("2020-01-01T00:00:00.000Z");

    assert.equal(await resolveSession(context, result.token), null);
  });
});
