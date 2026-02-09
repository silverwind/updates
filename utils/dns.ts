// DNS cache to avoid ENOTFOUND errors from parallel lookups
import dns from "node:dns";

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
        callback(null, cached[0].address, cached[0].family);
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
          cb(null, addresses[0].address, addresses[0].family);
        }
      }
    });
  } as any;
}
