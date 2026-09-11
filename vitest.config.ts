import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // e2e 由 Playwright 跑，不要被 vitest 收进来
    include: ["src/**/*.test.ts"],
    environment: "node",
    // 假上游会真的起 HTTP 服务并有超时用例，给足时间
    testTimeout: 20_000,
  },
});
