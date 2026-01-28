import {env} from "node:process";

export type Npmrc = {
  registry: string,
  ca?: string,
  cafile?: string,
  cert?: string,
  certfile?: string,
  key?: string,
  keyfile?: string,
  [other: string]: any,
};

export type AuthOptions = {
  recursive?: boolean,
  npmrc?: Npmrc,
};

export type NpmCredentials = {
  token: string,
  type: "Basic" | "Bearer",
  username?: string,
  password?: string,
};

// Inlined registry-auth-token functionality
function replaceEnvironmentVariable(token: string): string {
  return token.replace(/^\$\{?([^}]*)\}?$/, (_fullMatch, envVar) => env[envVar] || "");
}

function getBearerToken(tok: string | undefined): NpmCredentials | undefined {
  if (!tok) return undefined;
  const token = replaceEnvironmentVariable(tok);
  if (!token) return undefined;
  return {token, type: "Bearer"};
}

function getTokenForUsernameAndPassword(username: string | undefined, password: string | undefined): NpmCredentials | undefined {
  if (!username || !password) return undefined;

  const pass = Buffer.from(replaceEnvironmentVariable(password), "base64").toString("utf8");
  const token = Buffer.from(`${username}:${pass}`, "utf8").toString("base64");

  return {
    token,
    type: "Basic",
    password: pass,
    username,
  };
}

function getLegacyAuthToken(tok: string | undefined): NpmCredentials | undefined {
  if (!tok) return undefined;
  const token = replaceEnvironmentVariable(tok);
  if (!token) return undefined;
  return {token, type: "Basic"};
}

function getAuthInfoForUrl(regUrl: string, npmrc: Npmrc): NpmCredentials | undefined {
  const tokenKey = ":_authToken";
  const legacyTokenKey = ":_auth";
  const userKey = ":username";
  const passwordKey = ":_password";

  // try to get bearer token
  const bearerAuth = getBearerToken(npmrc[regUrl + tokenKey] || npmrc[`${regUrl}/${tokenKey}`]);
  if (bearerAuth) return bearerAuth;

  // try to get basic token
  const username = npmrc[regUrl + userKey] || npmrc[`${regUrl}/${userKey}`];
  const password = npmrc[regUrl + passwordKey] || npmrc[`${regUrl}/${passwordKey}`];
  const basicAuth = getTokenForUsernameAndPassword(username, password);
  if (basicAuth) return basicAuth;

  const basicAuthWithToken = getLegacyAuthToken(npmrc[regUrl + legacyTokenKey] || npmrc[`${regUrl}/${legacyTokenKey}`]);
  if (basicAuthWithToken) return basicAuthWithToken;

  return undefined;
}

function getLegacyAuthInfo(npmrc: Npmrc): NpmCredentials | undefined {
  if (!npmrc._auth) return undefined;
  const token = replaceEnvironmentVariable(npmrc._auth);
  if (!token) return undefined;
  return {token, type: "Basic"};
}

function normalizePath(path: string): string {
  return path[path.length - 1] === "/" ? path : `${path}/`;
}

function urlResolve(from: string, to: string): string {
  const resolvedUrl = new URL(to, new URL(from.startsWith("//") ? `./${from}` : from, "resolve://"));
  if (resolvedUrl.protocol === "resolve:") {
    const {pathname, search, hash} = resolvedUrl;
    return pathname + search + hash;
  }
  return resolvedUrl.toString();
}

function getRegistryAuthInfo(checkUrl: string, options: AuthOptions): NpmCredentials | undefined {
  if (!options.npmrc) return undefined;

  const parsed = new URL(checkUrl.startsWith("//") ? `http:${checkUrl}` : checkUrl);
  let pathname: string | undefined;

  while (pathname !== "/" && parsed.pathname !== pathname) {
    pathname = parsed.pathname || "/";

    const regUrl = `//${parsed.host}${pathname.replace(/\/$/, "")}`;
    const authInfo = getAuthInfoForUrl(regUrl, options.npmrc);
    if (authInfo) return authInfo;

    // break if not recursive
    if (!options.recursive) {
      return checkUrl.endsWith("/") ?
        undefined :
        getRegistryAuthInfo(new URL("./", parsed).toString(), options);
    }

    parsed.pathname = urlResolve(normalizePath(pathname), "..") || "/";
  }

  return undefined;
}

export default function registryAuthToken(checkUrl: string, options: AuthOptions): NpmCredentials | undefined {
  if (!options.npmrc) return undefined;
  return getRegistryAuthInfo(checkUrl, options) || getLegacyAuthInfo(options.npmrc);
}
