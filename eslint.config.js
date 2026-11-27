// Kiểm tra code: `npm run lint` — luật JS chuẩn (biến thừa, biến chưa khai báo, gán thừa…) cho máy chủ Node.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "uploads/**", ".cache/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-fallthrough": ["error", { allowEmptyCase: true }],
    },
  },
  // Test trình duyệt và script đo chạy cả mã trong trang (page.evaluate).
  {
    files: ["test/**", "scripts/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
