import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    // Build output and assembled copies. `next lint` skipped these implicitly; running eslint
    // directly (Next 16 removed the lint subcommand) does not, and they are generated files.
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "public/**",
      // Published deployment output, and the review copy beside it. Review mode writes its build to
      // deployments/{id}/review-build, deliberately outside public/ so nothing serves it statically
      // — which also puts generated customer code somewhere eslint looks. One bundled site added
      // 714 warnings here.
      "deployments/**",
      // The whole desktop tree: `next lint` only ever covered the Next app, and the Electron main
      // process is CommonJS by design (it dynamic-requires the standalone server at a runtime path).
      // Widening lint to it is a deliberate change, not a side effect of dropping `next lint`.
      "desktop/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { 
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_"
      }],
      // Warn on console usage; allow error/warn
      "no-console": ["warn", { allow: ["error", "warn"] }],
      // Apostrophes/quotes in JSX copy are fine — React escapes text content
      "react/no-unescaped-entities": "off",
      // The desktop app's Electron has no window.prompt(): it throws. Ask in the app's own dialog,
      // as the File Explorer's CreateItemDialog does.
      "no-restricted-globals": ["error", { name: "prompt", message: "Electron has no window.prompt(); ask in the app's own dialog." }],
      "no-restricted-properties": ["error",
        { object: "window", property: "prompt", message: "Electron has no window.prompt(); ask in the app's own dialog." },
        { object: "globalThis", property: "prompt", message: "Electron has no window.prompt(); ask in the app's own dialog." },
      ]
    }
  }
];

export default eslintConfig;
