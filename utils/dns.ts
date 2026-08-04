// DNS cache to avoid ENOTFOUND errors from parallel lookups
// TODO: Use undici once https://github.com/nodejs/node/issues/43187 is resolved
import dns from "node:dns";

// Hand a lookup result to one waiter, honoring a requested address family when the
// result has a match and falling back to the first address otherwise.
function deliver(callback: (...args: any[]) => void, options: any, addresses: {address: string, family: number}[]) {
  if (options.all) {
    callback(null, addresses);
  } else {
    const addr = addresses.find(({family}) => family === options.family) ?? addresses[0];
    callback(null, addr.address, addr.family);
  }
}

export function enableDnsCache() {
  const dnsCache = new Map<string, {address: string, family: number}[]>();
  const dnsInflight = new Map<string, Array<{options: any, callback: (...args: any[]) => void}>>();
  const origLookup = dns.lookup as any;

  dns.lookup = function(hostname: string, ...rest: any[]) {
    let options: any = {};
    let callback: (...args: any[]) => void;
    if (typeof rest[0] === "function") {
      callback = rest[0];
    } else {
      options = typeof rest[0] === "number" ? {family: rest[0]} : (rest[0] || {});
      callback = rest[1];
    }

    const cached = dnsCache.get(hostname);
    if (cached) {
      deliver(callback, options, cached);
      return;
    }

    if (dnsInflight.has(hostname)) {
      dnsInflight.get(hostname)!.push({options, callback});
      return;
    }

    dnsInflight.set(hostname, [{options, callback}]);
    origLookup.call(dns, hostname, {all: true}, (err: any, addresses: any) => {
      const waiters = dnsInflight.get(hostname)!;
      dnsInflight.delete(hostname);
      if (!err && addresses?.length) {
        dnsCache.set(hostname, addresses);
      }
      // A success with no addresses would crash the non-`all` branch on addr.address; treat it as a failure.
      const lookupErr = err || (addresses?.length ? null : Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {code: "ENOTFOUND", hostname}));
      for (const {options: opts, callback: cb} of waiters) {
        if (lookupErr) {
          cb(lookupErr);
        } else {
          deliver(cb, opts, addresses);
        }
      }
    });
  } as any;
}
