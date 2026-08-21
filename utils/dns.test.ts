import dns from "node:dns";
import {enableDnsCache} from "./dns.ts";

const systemLookup = dns.lookup;

afterEach(() => {
  dns.lookup = systemLookup;
  vi.restoreAllMocks();
});

test("DNS caching preserves lookup semantics and can be disabled", async () => {
  const calls: Array<{hostname: string, options: unknown}> = [];
  const original = ((hostname: string, options: unknown, callback: (...args: Array<any>) => void) => {
    calls.push({hostname, options});
    queueMicrotask(() => callback(null, "192.0.2.1", 4));
  }) as typeof dns.lookup;
  dns.lookup = original;
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const disable = enableDnsCache();
  const options = {family: 4, hints: dns.ADDRCONFIG, order: "ipv4first" as const};
  const lookup = (lookupOptions: object) => new Promise<Array<any>>(resolve => {
    dns.lookup("example.com", lookupOptions, (...args: Array<any>) => resolve(args));
  });

  expect(await lookup(options)).toEqual([null, "192.0.2.1", 4]);
  let synchronous = true;
  const cached = new Promise<void>(resolve => {
    dns.lookup("example.com", options, () => {
      expect(synchronous).toBe(false);
      resolve();
    });
  });
  synchronous = false;
  await cached;
  expect(calls).toEqual([{hostname: "example.com", options}]);

  const allOptions = {all: true, hints: dns.V4MAPPED, verbatim: false};
  await lookup(allOptions);
  expect(calls[1]).toEqual({hostname: "example.com", options: allOptions});

  now.mockReturnValue(61001);
  await lookup(options);
  expect(calls).toHaveLength(3);
  disable();
  expect(dns.lookup).toBe(original);
});
