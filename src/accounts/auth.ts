/**
 * 账号与会话。
 *
 * 口令哈希用 PBKDF2-SHA256：Workers 的 WebCrypto 没有 scrypt/argon2，而
 * PBKDF2 是其中唯一经过审查、可调迭代次数的慢哈希。裸 SHA-256 绝对不行 ——
 * 一块消费级显卡每秒能算几十亿次，库一旦泄露等于明文。
 */

import { and, eq, gt } from "drizzle-orm";

import { balanceTransactions, sessions, users, type User } from "@/db/schema";
import type { BuyRelayContext } from "@/runtime/context";

/**
 * 迭代参数。
 *
 * **Cloudflare Workers 把单次 PBKDF2 的迭代次数硬上限设在 100000**
 * （超过会抛 NotSupportedError: iteration counts above 100000 are not supported）。
 * 这是平台约束，不是可调项 —— 而且 Node 上没有这个限制，所以只跑单测发现不了，
 * 必须在真实运行时上验证。
 *
 * 单轮 10 万低于 OWASP 对 PBKDF2-SHA256 的建议值，所以用**多轮串联**补足：
 * 每轮的输出作为下一轮的输入口令，总工作量等于 ROUNDS × ITERATIONS。
 * 攻击者无法跳过中间轮次，所以串联的成本是可加的。
 *
 * 两个参数都写进哈希串，日后调整不会让旧口令失效。
 */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_ROUNDS = 3;

const SESSION_DAYS = 30;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function deriveOnce(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return toHex(bits);
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
  rounds: number,
): Promise<string> {
  let value = password;
  for (let i = 0; i < rounds; i += 1) {
    value = await deriveOnce(value, salt, iterations);
  }
  return value;
}

/** 哈希串格式：pbkdf2$迭代次数$轮数$盐$派生值。参数内嵌，日后调参不废旧口令。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS, PBKDF2_ROUNDS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${PBKDF2_ROUNDS}$${toHex(salt.buffer)}$${hash}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, iterations, rounds, saltHex, expected] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterations || !rounds || !saltHex || !expected) {
    return false;
  }

  const actual = await derive(
    password,
    fromHex(saltHex),
    Number(iterations),
    Number(rounds),
  );

  // 定长比较，避免按字节短路带来的时序侧信道。
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export const SESSION_COOKIE = "relaykit_session";

export type AuthResult =
  | { ok: true; user: User; token: string }
  | { ok: false; error: string };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function issueSession(
  context: BuyRelayContext,
  userId: string,
): Promise<string> {
  // token 明文只回给浏览器一次，库里只存哈希 —— 数据库被读到也无法冒充登录。
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const now = new Date();

  await context.db.insert(sessions).values({
    tokenHash: await sha256Hex(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
    createdAt: now.toISOString(),
  });

  return token;
}

export async function register(
  context: BuyRelayContext,
  email: string,
  password: string,
): Promise<AuthResult> {
  const normalized = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { ok: false, error: "invalid_email" };
  }
  if (password.length < 8) return { ok: false, error: "weak_password" };

  const existing = await context.db
    .select()
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  if (existing.length > 0) return { ok: false, error: "email_taken" };

  const user = {
    id: crypto.randomUUID(),
    email: normalized,
    passwordHash: await hashPassword(password),
    balance: "0",
    totalSpent: "0",
    createdAt: new Date().toISOString(),
  };

  try {
    await context.db.insert(users).values(user);
  } catch {
    // 并发注册同一邮箱时唯一索引会挡下，转成同样的业务错误。
    return { ok: false, error: "email_taken" };
  }

  return { ok: true, user: user as User, token: await issueSession(context, user.id) };
}

export async function login(
  context: BuyRelayContext,
  email: string,
  password: string,
): Promise<AuthResult> {
  const rows = await context.db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);

  const user = rows[0];

  // 用户不存在时也走一次同样开销的派生，让「邮箱是否注册过」无法由响应时间推断。
  if (!user) {
    await derive(password, new Uint8Array(16), PBKDF2_ITERATIONS, PBKDF2_ROUNDS);
    return { ok: false, error: "bad_credentials" };
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, error: "bad_credentials" };
  }

  return { ok: true, user, token: await issueSession(context, user.id) };
}

export async function resolveSession(
  context: BuyRelayContext,
  token: string | undefined,
): Promise<User | null> {
  if (!token) return null;

  const rows = await context.db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, await sha256Hex(token)),
        gt(sessions.expiresAt, new Date().toISOString()),
      ),
    )
    .limit(1);

  return rows[0]?.user ?? null;
}

export async function logout(
  context: BuyRelayContext,
  token: string | undefined,
): Promise<void> {
  if (!token) return;
  await context.db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)));
}

/** 清理过期会话。挂在 Cron 上，否则 sessions 表只增不减。 */
export async function pruneSessions(context: BuyRelayContext): Promise<void> {
  await context.db
    .delete(sessions)
    .where(gt(new Date().toISOString() as never, sessions.expiresAt));
}

/** 取一条余额流水的最新余额，用于并发下的一致性校验。 */
export async function getUser(
  context: BuyRelayContext,
  userId: string,
): Promise<User | null> {
  const rows = await context.db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

/** 暴露给测试：确保单轮迭代数永不超过 Workers 的硬上限。 */
export const PBKDF2_PARAMS = {
  iterations: PBKDF2_ITERATIONS,
  rounds: PBKDF2_ROUNDS,
  /** Workers 的平台上限。见 PBKDF2_ITERATIONS 的注释。 */
  workersMaxIterations: 100_000,
};

export { balanceTransactions };
