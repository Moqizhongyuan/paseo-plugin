/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ["@react-native"],
  ignorePatterns: ["node_modules/", "coverage/", "dist/"],
  rules: {
    // `void` explicitly marks fire-and-forget async UI/RPC calls.
    "no-void": "off",
  },
};
