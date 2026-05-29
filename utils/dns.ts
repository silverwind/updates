// DNS cache to avoid ENOTFOUND errors from parallel lookups
// TODO: Use undici once https://github.com/nodejs/node/issues/43187 is resolved
import dns from "node:dns";

// Honor a requested address family when the cached result has a match; fall back to the first address otherwise.
function selectAddr(addresses: {address: string, family: number}[], options: any) {
  if (options.family === 4 || options.family === 6) {
    const match = addresses.find(a => a.family === options.family);
    if (match) return match;
  }
  return addresses[0];
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
      if (options.all) {
        callback(null, cached);
      } else {
        const addr = selectAddr(cached, options);
        callback(null, addr.address, addr.family);
      }
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
      for (const {options: opts, callback: cb} of waiters) {
        if (err) {
          cb(err);
        } else if (opts.all) {
          cb(null, addresses);
        } else {
          const addr = selectAddr(addresses, opts);
          cb(null, addr.address, addr.family);
        }
      }
    });
  } as any;
}
