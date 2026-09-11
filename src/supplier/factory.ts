/**
 * 按配置构造上游适配器。
 *
 * 这是「换上游只需改配置」这一承诺的落点：业务代码只拿到 SupplierAdapter，
 * 永远不知道背后是 acg-faka、是演示桩、还是将来新增的其它协议。
 */

import { AcgFakaAdapter } from "@/supplier/acgfaka/client";
import { AcgFakaPublicAdapter } from "@/supplier/acgfaka/public";
import { MockAdapter } from "@/supplier/mock/adapter";
import type { SupplierAdapter } from "@/supplier/types";
import type { SupplierConfig } from "@/config/schema";

export function createSupplier(config: SupplierConfig): SupplierAdapter {
  switch (config.driver) {
    case "acgfaka":
      // schema 的 superRefine 已经保证这三个字段在此驱动下必定存在，
      // 这里的断言不会在运行期兜到 undefined。
      return new AcgFakaAdapter({
        domain: config.domain!,
        appId: config.appId!,
        appKey: config.appKey!,
        timeoutMs: config.timeoutMs,
      });

    case "acgfaka-public":
      // 只读目录：不需要凭据，但也下不了单。见 public.ts 的文件头注释。
      return new AcgFakaPublicAdapter({
        domain: config.domain!,
        timeoutMs: config.timeoutMs,
        costBasis: config.costBasis,
      });

    case "mock":
      return new MockAdapter();

    default: {
      // 新增 driver 却忘了在这里分支时，TypeScript 会在编译期报错而不是运行期。
      const exhaustive: never = config.driver;
      throw new Error(`未知的供货商驱动: ${String(exhaustive)}`);
    }
  }
}

/** 把配置里的多个上游构造成 id → adapter 的映射。 */
export function createSuppliers(
  configs: readonly SupplierConfig[],
): Map<string, SupplierAdapter> {
  return new Map(configs.map((config) => [config.id, createSupplier(config)]));
}
