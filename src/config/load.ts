/**
 * 配置加载：取原始对象 → 展开 ${ENV} → 校验 → 冻结。
 *
 * 设计取舍一：**结构进文件，密钥进环境变量**。
 * 配置文件是要提交进仓库、要能 diff、要能贴到 issue 里求助的；app_key 和
 * 收款地址不能在里面。所以任何字符串值都支持 ${VAR} 插值，
 * 让 buyrelay.config.yaml 可以安全地公开。
 *
 * 设计取舍二：**运行时无关**。
 * 这个模块要同时跑在 Node（本地开发、测试、CLI）和 Cloudflare Workers（生产）上，
 * 而 Workers 既没有 fs 也没有真正的 process.env —— 密钥是通过 `env` 绑定注入的。
 * 于是：
 *   - 文件读取只在显式传 `path` 时发生（Node 专用路径，Workers 永远走不到）；
 *   - 环境变量来源可注入，Workers 侧把 `env` 绑定传进来即可。
 * 生产构建走 `scripts/build-config.mjs` 把 YAML 预生成成 TS 模块，
 * 运行期直接 import，完全不碰 fs。
 */

import { parse as parseYaml } from "yaml";

import { configSchema, type BuyRelayConfig } from "./schema";

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n\n${issues.join("\n")}` : message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** ${VAR} 与 ${VAR:-默认值}。后者让"本地开发不配也能跑"成为可能。 */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * 递归展开字符串里的环境变量。
 *
 * 刻意**不做**的事：不在缺失变量时静默留空。留空会让 appKey 变成空串，
 * 然后在第一次真实下单时以"密钥错误"的形式爆出来 —— 那时候客户已经付款了。
 * 宁可在启动期直接拒绝加载。
 */
function interpolate(
  value: unknown,
  path: string,
  missing: string[],
  env: EnvSource,
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
      const found = env[name];
      if (found !== undefined && found !== "") return found;
      if (fallback !== undefined) return fallback;
      missing.push(`${path} 引用了未设置的环境变量 \${${name}}`);
      return "";
    });
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      interpolate(item, `${path}[${index}]`, missing, env),
    );
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolate(item, path === "" ? key : `${path}.${key}`, missing, env),
      ]),
    );
  }

  return value;
}

/** 把 zod 的报错整理成人能直接照着改的形式。 */
function formatIssues(error: import("zod").ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join(".") : "(根)";
    return `  • ${location}: ${issue.message}`;
  });
}

/**
 * 跨字段的一致性检查 —— 这些约束 zod 的单字段校验管不到，
 * 但配错了同样会在生产上以"卖了货收不到钱"或"算错价"的形式爆出来。
 */
function checkCrossFieldConsistency(config: BuyRelayConfig): string[] {
  const problems: string[] = [];
  const displayCurrency = config.store.currency;

  // 每个上游的结算币若与展示币不同，必须有对应汇率，否则定价引擎无从换算。
  if (config.pricing.fx.source === "static") {
    for (const supplier of config.suppliers) {
      if (supplier.currency === displayCurrency) continue;
      const key = `${supplier.currency}_${displayCurrency}`;
      if (!config.pricing.fx.rates[key]) {
        problems.push(
          `  • pricing.fx.rates: 缺少 "${key}"。上游 "${supplier.id}" 以 ${supplier.currency} 结算，` +
            `而店铺以 ${displayCurrency} 展示，必须提供这条汇率。`,
        );
      }
    }
  }

  // overrides 指向不存在的供货商，通常是改了 supplier.id 却忘了同步改这里。
  const supplierIds = new Set(config.suppliers.map((item) => item.id));
  for (const [index, override] of config.pricing.overrides.entries()) {
    if (!supplierIds.has(override.supplier)) {
      problems.push(
        `  • pricing.overrides[${index}].supplier: "${override.supplier}" 不在 suppliers 列表里`,
      );
    }
  }

  if (!config.payments.chains.some((chain) => chain.enabled)) {
    problems.push("  • payments.chains: 所有链都被禁用了，客户将无法付款");
  }

  // 同一条链配置两次，监听器会重复入账。
  const seenChains = new Set<string>();
  for (const chain of config.payments.chains) {
    if (seenChains.has(chain.id)) {
      problems.push(`  • payments.chains: "${chain.id}" 重复配置，会导致重复入账`);
    }
    seenChains.add(chain.id);
  }

  // 关掉毛利保护是合法的，但值得在启动日志里留个痕迹 —— 这是最容易亏钱的开关。
  if (config.pricing.minMarginPercent === 0) {
    problems.push(
      "  • pricing.minMarginPercent 为 0：已关闭最低毛利保护，汇率波动或上游涨价时可能低于成本成交。" +
        "确认这是你想要的再继续（把它设为 0 以外的值即可消除此项）。",
    );
  }

  return problems;
}

/** 环境变量来源。Node 传 process.env，Workers 传 `env` 绑定。 */
export type EnvSource = Record<string, string | undefined>;

export interface LoadOptions {
  /** 直接给出配置对象。生产（Workers）走这条，值来自构建期生成的模块。 */
  raw?: unknown;
  /** YAML 原文。CLI / 构建脚本用。 */
  text?: string;
  /** 配置文件路径。**仅 Node 可用** —— Workers 上没有 fs。 */
  path?: string;
  /** 密钥来源。默认 globalThis.process?.env（Workers 上为空对象）。 */
  env?: EnvSource;
  /** 允许带警告继续（minMarginPercent=0 之类）。默认 false，启动期从严。 */
  allowWarnings?: boolean;
}

/** Workers 上没有 process，直接引用会抛 ReferenceError。 */
function defaultEnvSource(): EnvSource {
  return (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};
}

function parseYamlOrThrow(text: string, label: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new ConfigError(`配置不是合法的 YAML：${label}`, [
      `  • ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

/** 读文件。抽出来单独放，是为了让 Workers 打包时这条分支能被静态判定为不可达。 */
function readConfigFile(path: string): string {
  // 动态 require 而非顶层 import：顶层 import "node:fs" 会让 Workers 的打包
  // 无条件把 fs 拉进 bundle，即便这条路径在生产上永远不会被调用。
  const nodeRequire = (
    globalThis as { require?: (id: string) => { readFileSync(p: string, e: string): string } }
  ).require;

  try {
    if (nodeRequire) return nodeRequire("node:fs").readFileSync(path, "utf8");
    throw new Error("当前运行时不支持读取文件");
  } catch {
    throw new ConfigError(
      `读不到配置文件：${path}\n` +
        `复制 buyrelay.config.example.yaml 改名为 buyrelay.config.yaml 即可开始。\n` +
        `（若这是在 Cloudflare Workers 上，说明构建期没有生成配置模块，` +
        `请检查 prebuild 是否执行了 scripts/build-config.mjs）`,
    );
  }
}

export function loadConfig(options: LoadOptions = {}): BuyRelayConfig {
  const envSource = options.env ?? defaultEnvSource();

  const source =
    options.raw ??
    (options.text !== undefined
      ? parseYamlOrThrow(options.text, "(inline)")
      : (() => {
          const path =
            options.path ?? envSource.DAICHONG_CONFIG ?? "buyrelay.config.yaml";
          return parseYamlOrThrow(readConfigFile(path), path);
        })());

  const missing: string[] = [];
  const interpolated = interpolate(source, "", missing, envSource);

  if (missing.length > 0) {
    throw new ConfigError(
      "配置引用了未设置的环境变量",
      missing.map((item) => `  • ${item}`),
    );
  }

  const parsed = configSchema.safeParse(interpolated);
  if (!parsed.success) {
    throw new ConfigError("配置校验失败", formatIssues(parsed.error));
  }

  const problems = checkCrossFieldConsistency(parsed.data);
  if (problems.length > 0 && !options.allowWarnings) {
    throw new ConfigError("配置存在不一致", problems);
  }

  return Object.freeze(parsed.data);
}
