declare module "@pnpm/npm-conf" {
  interface Config {
    get(key: string): any;
    root: Record<string, any>;
    list: Array<Record<string, any>>;
  }

  interface NpmConfResult {
    config: Config;
    warnings: string[];
    failedToLoadBuiltInConfig: boolean;
  }

  function npmConf(opts?: Record<string, any>, types?: any, defaults?: any): NpmConfResult;

  export = npmConf;
}
