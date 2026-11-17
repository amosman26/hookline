// @ts-check

/** @type {import("@commitlint/types").UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // `security` is our own type for hardening changes (signing, rate limits).
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "security",
        "style",
        "test",
      ],
    ],
    "scope-enum": [
      2,
      "always",
      [
        "adr",
        "api",
        "dashboard",
        "db",
        "deps",
        "load",
        "observability",
        "readme",
        "release",
        "signing",
        "worker",
      ],
    ],
    "header-max-length": [2, "always", 72],
  },
};
