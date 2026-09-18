// eslint-config-next 16+ 原生导出 flat config（eslintrc 已弃用），直接展开即可。
import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      ".open-next/**",
      "node_modules/**",
      "public/brand/**",
      // vendored 压缩产物不 lint（bootstrap 等，一次性入库）。
      "public/vendor/**",
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
  // react-compiler 误报豁免：挂载时读一次 sessionStorage/localStorage 再 setState
  // 是标准 hydration 模式；document.cookie 赋值是合法 DOM 写。
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // 测试与脚本放宽：允许 any、非组件导出；业务代码保持严格档。
  {
    files: ["**/*.test.ts", "scripts/**/*.ts", "worker/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];

export default config;
