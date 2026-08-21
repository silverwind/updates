import dns from "node:dns";

const maxEntries = 512;
const ttl = 60000;
let active: {lookup: typeof dns.lookup, original: typeof dns.lookup, users: number} | null = null;

export function enableDnsCache(): () => void {
  if (active) {
    if (dns.lookup === active.lookup) {
      active.users++;
      return disable(active);
    }
    active = null;
  }

  const dnsCache = new Map<string, {expires: number, result: Array<any>}>();
  const dnsInflight = new Map<string, Array<(...args: any[]) => void>>();
  const origLookup = dns.lookup as any;

  const lookup = function(hostname: string, ...rest: any[]) {
    const hasOptions = typeof rest[0] !== "function";
    const lookupOptions = hasOptions ? rest[0] : undefined;
    const options = typeof lookupOptions === "number" ? {family: lookupOptions} : lookupOptions || {};
    const callback: (...args: any[]) => void = hasOptions ? rest[1] : rest[0];
    if (typeof callback !== "function") return origLookup.call(dns, hostname, ...rest);
    const key = JSON.stringify([
      hostname, options.family ?? 0, options.hints ?? 0, Boolean(options.all),
      options.order ?? "", options.verbatim ?? "",
    ]);

    const cached = dnsCache.get(key);
    if (cached) {
      if (cached.expires > Date.now()) {
        queueMicrotask(() => callback(null, ...cached.result));
        return;
      }
      dnsCache.delete(key);
    }

    const inflight = dnsInflight.get(key);
    if (inflight) {
      inflight.push(callback);
      return;
    }

    dnsInflight.set(key, [callback]);
    const complete = (err: any, ...result: Array<any>) => {
      queueMicrotask(() => {
        const waiters = dnsInflight.get(key)!;
        dnsInflight.delete(key);
        if (!err) {
          if (dnsCache.size >= maxEntries) dnsCache.delete(dnsCache.keys().next().value!);
          dnsCache.set(key, {expires: Date.now() + ttl, result});
        }
        for (const waiter of waiters) waiter(err, ...result);
      });
    };
    try {
      if (hasOptions) origLookup.call(dns, hostname, lookupOptions, complete);
      else origLookup.call(dns, hostname, complete);
    } catch (err) {
      dnsInflight.delete(key);
      throw err;
    }
  } as typeof dns.lookup;

  dns.lookup = lookup;
  active = {lookup, original: origLookup, users: 1};
  return disable(active);
}

function disable(state: NonNullable<typeof active>): () => void {
  let disabled = false;
  return () => {
    if (disabled) return;
    disabled = true;
    state.users--;
    if (state.users) return;
    if (dns.lookup === state.lookup) dns.lookup = state.original;
    if (active === state) active = null;
  };
}
