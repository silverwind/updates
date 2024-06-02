export default {
  exclude: [
    "eslint",
    "registry-auth-token",
    "semver",
    "execa", // Bun: SyntaxError: Export named 'aborted' not found in module 'util'.
  ],
};
