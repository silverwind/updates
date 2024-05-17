export default {
  exclude: [
    "eslint",
    "registry-auth-token",
    "semver",
    "execa", // events.addAbortListener not available in bun
  ],
};
