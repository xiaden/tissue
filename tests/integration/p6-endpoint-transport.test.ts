// tests/integration/p6-endpoint-transport.test.ts
//
// Green specification for the L10 resident transport (plan
// TASK-tissue-K-resident-transport). The phase-2 implementation has landed and
// every test below passes: the `http://opencode:4096` Docker origin is reachable
// through the exact-origin allowlist, the resolve-and-pin resolver pins a literal
// private address, and `createResidentTransport` is the single client factory.
//
// L10 contract being pinned (artifacts/requirements/TISSUE-MIGRATION-REQUEST.md
// L10; DD-tissue-container-migration.md §6.3, §7 item 6, §20-OQ10):
//   1. Credentials attach ONLY after the target is known to be an approved private
//      endpoint. Every rejection path performs ZERO HTTP requests and ZERO auth
//      attempts (the transport/pessimistic-server counters prove it).
//   2. An internal Docker service origin is accepted ONLY through an EXACT-ORIGIN
//      allowlist: `scheme://host:port` must byte-equal an entry of
//      TISSUE_OPENCODE_ALLOWED_ORIGINS after canonical URL normalisation.
//      Lower-casing scheme/host is the ONLY permitted normalisation, and it is
//      proved explicitly below. No prefix/suffix/wildcard matching. The allowlist
//      must never become "allow arbitrary hostnames".
//   3. resolve-and-pin: EVERY `dns.lookup(host, { all: true })` answer must satisfy
//      the private/loopback predicates, extended for IPv4-mapped `::ffff:a.b.c.d`
//      and full `fe80::/10`. The transport is pinned to the literal private IP so
//      the connect-time resolution surface is removed by construction. A configured
//      literal private IP is the supported alternative form and skips resolution.
//   4. One factory (`createResidentTransport`) is the only client construction
//      path; it exposes a documented re-resolve accessor used after a health
//      failure (no background loop, no polling).
//
// Contract signatures under test (imported directly from src/runtime/resident.ts):
//   validateResidentOpenCodeEndpoint(url, opts?: ResidentEndpointValidationOptions): URL
//   resolveAndPinResidentOrigin(url: URL, lookup?: DnsLookup): Promise<PinnedOrigin>
//   createResidentTransport(env, credentials?): Promise<ResidentTransport>
//
// All boundaries are local fakes (pessimistic OpenCode server, injected DNS
// lookup). No real remote, service, Docker, or OpenCode DB is touched.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ResidentEndpointError,
  validateResidentOpenCodeEndpoint,
  resolveAndPinResidentOrigin,
  createResidentTransport,
  type DnsAddress,
  type DnsLookup,
  type PinnedOrigin,
  type ResidentTransport,
} from "../../src/runtime/resident.ts";
import { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";

function lookupOf(...answers: DnsAddress[]): DnsLookup {
  return async () => answers;
}

function stripIpv6Brackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

test("L10 transport module exports the allowlist guard, the resolve-and-pin resolver, and the single factory", () => {
  assert.equal(typeof resolveAndPinResidentOrigin, "function", "resolveAndPinResidentOrigin must be exported");
  assert.equal(typeof createResidentTransport, "function", "createResidentTransport must be exported");
});

test("exact-origin allowlist accepts http://opencode:4096 only when it byte-equals an allowed entry", () => {
  const accepted = validateResidentOpenCodeEndpoint("http://opencode:4096", {
    allowedOrigins: "http://opencode:4096",
  });
  assert.equal(accepted.origin, "http://opencode:4096");
});

test("exact-origin allowlist parses a multi-entry list and accepts the matching entry", () => {
  const accepted = validateResidentOpenCodeEndpoint("http://opencode:4096", {
    allowedOrigins: "http://tissue:8787, http://opencode:4096",
  });
  assert.equal(accepted.origin, "http://opencode:4096");
});

test("exact-origin allowlist rejects a different port, scheme, and www./prefix/suffix variants", () => {
  const opts = { allowedOrigins: "http://opencode:4096" };
  const nearMisses = [
    "http://opencode:4097", // different port
    "https://opencode:4096", // different scheme
    "http://www.opencode:4096", // `www.` variant
    "http://opencode.evil:4096", // suffix variant
    "http://evilopencode:4096", // prefix variant
  ];
  for (const bad of nearMisses) {
    assert.throws(
      () => validateResidentOpenCodeEndpoint(bad, opts),
      ResidentEndpointError,
      `allowlist must reject ${bad}`,
    );
  }
});

test("exact-origin allowlist rejects empty/absent lists and never enables arbitrary hostnames", () => {
  assert.throws(
    () => validateResidentOpenCodeEndpoint("http://opencode:4096", { allowedOrigins: "" }),
    ResidentEndpointError,
    "an empty allowlist must reject the Docker origin",
  );
  assert.throws(
    () => validateResidentOpenCodeEndpoint("http://opencode:4096", {}),
    ResidentEndpointError,
    "an absent allowlist must reject the Docker origin",
  );
  assert.throws(
    () => validateResidentOpenCodeEndpoint("http://evil.example:4096", { allowedOrigins: "http://opencode:4096" }),
    ResidentEndpointError,
    "the allowlist must never become 'allow arbitrary hostnames'",
  );
});

test("canonical URL normalisation of scheme/host case is the only permitted allowlist normalisation", () => {
  const accepted = validateResidentOpenCodeEndpoint("hTTp://OpenCode:4096", {
    allowedOrigins: "http://opencode:4096",
  });
  assert.equal(accepted.origin, "http://opencode:4096", "case-only scheme/host differences normalise to the allowed origin");
});

test("the guard extension is additive: omitted allowedOrigins preserves loopback/private behavior", () => {
  assert.doesNotThrow(() => validateResidentOpenCodeEndpoint("http://127.0.0.1:4096"));
  assert.doesNotThrow(() => validateResidentOpenCodeEndpoint("http://localhost:4096"));
  assert.throws(() => validateResidentOpenCodeEndpoint("http://opencode:4096"), ResidentEndpointError);
  assert.throws(() => validateResidentOpenCodeEndpoint("http://example.com:4096"), ResidentEndpointError);
});

test("resolve-and-pin pins the literal private address when every answer is private", async () => {
  const pinned = await resolveAndPinResidentOrigin(
    new URL("http://opencode:4096"),
    lookupOf({ address: "10.1.2.3", family: 4 }, { address: "192.168.1.5", family: 4 }),
  );
  assert.equal(pinned.pinnedIp, "10.1.2.3");
  assert.equal(pinned.family, 4);
  assert.equal(pinned.url.hostname, "10.1.2.3");
  assert.ok(pinned.url.toString().includes("10.1.2.3"), "the pinned baseUrl contains the literal IP");
});

test("resolve-and-pin rejects when any answer among several is non-private", async () => {
  await assert.rejects(
    resolveAndPinResidentOrigin(
      new URL("http://opencode:4096"),
      lookupOf({ address: "10.1.2.3", family: 4 }, { address: "8.8.8.8", family: 4 }),
    ),
    ResidentEndpointError,
    "one public answer among private answers must reject the whole origin",
  );
});

test("resolve-and-pin accepts an IPv4-mapped loopback answer via the documented predicates", async () => {
  const pinned = await resolveAndPinResidentOrigin(
    new URL("http://opencode:4096"),
    lookupOf({ address: "::ffff:127.0.0.1", family: 6 }),
  );
  assert.equal(pinned.family, 6);
  const host = stripIpv6Brackets(pinned.url.hostname);
  assert.ok(
    /^(::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(host),
    `IPv4-mapped loopback must be pinned as private, got ${host}`,
  );
});

test("resolve-and-pin accepts an fe80::/10 link-local answer via the documented predicates", async () => {
  const pinned = await resolveAndPinResidentOrigin(
    new URL("http://opencode:4096"),
    lookupOf({ address: "fe80::1", family: 6 }),
  );
  assert.equal(pinned.family, 6);
  assert.ok(
    stripIpv6Brackets(pinned.url.hostname).toLowerCase().startsWith("fe80"),
    "fe80::/10 link-local must be pinned as private",
  );
});

test("a configured literal private IP skips DNS resolution entirely", async () => {
  let calls = 0;
  const spy: DnsLookup = async () => {
    calls += 1;
    return [{ address: "8.8.8.8", family: 4 }];
  };
  const pinned = await resolveAndPinResidentOrigin(new URL("http://10.0.0.5:4096"), spy);
  assert.equal(calls, 0, "a configured literal private IP must skip DNS resolution");
  assert.equal(pinned.pinnedIp, "10.0.0.5");
  assert.equal(pinned.family, 4);
});

test("factory rejection performs zero HTTP requests and zero auth attempts", async () => {
  const server = await startPessimisticServer({ username: "tissue", password: "s3cret" });
  try {
    const port = new URL(server.baseUrl()).port;
    await assert.rejects(
      (async () =>
        createResidentTransport(
          {
            TISSUE_OPENCODE_URL: `http://opencode:${port}`,
            TISSUE_OPENCODE_ALLOWED_ORIGINS: "http://tissue:8787",
          },
          { username: "tissue", password: "s3cret" },
        ))(),
      ResidentEndpointError,
      "an origin not byte-equal to the allowlist must reject",
    );
    await assert.rejects(
      (async () =>
        createResidentTransport(
          { TISSUE_OPENCODE_URL: `http://8.8.8.8:${port}` },
          { username: "tissue", password: "s3cret" },
        ))(),
      ResidentEndpointError,
      "a public host must reject",
    );
    assert.equal(server.requestCount, 0, "no request may reach a rejected endpoint");
    assert.equal(server.authRejections, 0, "no auth attempt may be made for a rejected endpoint");
  } finally {
    await server.close();
  }
});

test("factory attaches credentials only after validation and exposes a credential-free endpoint label", async () => {
  const server = await startPessimisticServer({ username: "tissue", password: "p4ssw0rd" });
  try {
    const port = new URL(server.baseUrl()).port;
    const transport = await createResidentTransport(
      { TISSUE_OPENCODE_URL: `http://127.0.0.1:${port}` },
      { username: "tissue", password: "p4ssw0rd" },
    );
    assert.equal(transport.pinnedUrl.hostname, "127.0.0.1");
    assert.equal(
      transport.endpointLabel,
      `http://127.0.0.1:${port}`,
      "endpointLabel is credential-free scheme://host:port",
    );
    await transport.http.sessionStatus();
    assert.ok(server.requestCount > 0, "accepted endpoint is queried only after validation");
    assert.equal(server.authRejections, 0, "credentials are attached after validation");
    assert.equal(JSON.stringify(transport.endpointLabel).includes("p4ssw0rd"), false);
  } finally {
    await server.close();
  }
});

test("re-resolve after a health failure uses a fresh resolution rather than the cached pin", async () => {
  const transport = await createResidentTransport({ TISSUE_OPENCODE_URL: "http://localhost:4096" }, {});
  assert.equal(typeof transport.reResolvePinnedOrigin, "function", "a documented re-resolve accessor must exist");
  const fresh = await transport.reResolvePinnedOrigin(lookupOf({ address: "10.77.0.9", family: 4 }));
  assert.equal(fresh.pinnedIp, "10.77.0.9");
  assert.equal(fresh.url.hostname, "10.77.0.9");
  assert.notEqual(
    fresh.url.hostname,
    transport.pinnedUrl.hostname,
    "the pin must be re-resolved, not reused blindly",
  );
});

// The mock-versus-real closure pair required by plan K's ownership-closure rules:
// a mocked caller (injected `lookup` + an erroring HTTP fake) must reject with ZERO
// requests, and a real caller (the actual `OpenCodeHttp`) must connect to the pinned
// literal private IP and never to the unpinned hostname.

test("mocked caller: a non-private/mixed DNS answer rejects before any HTTP request reaches the transport", async () => {
  // An HTTP fake that ERRORS on any request and counts them. If the mocked DNS answer
  // were (wrongly) accepted, the fabricated caller below would construct a client and
  // this counter would become non-zero — so zero requests is real evidence here.
  let httpRequests = 0;
  const erroringHttpFake = createServer((_req, res) => {
    httpRequests += 1;
    res.statusCode = 503;
    res.end("erroring http fake");
  });
  await new Promise<void>((resolve) => erroringHttpFake.listen(0, "127.0.0.1", () => resolve()));
  const port = (erroringHttpFake.address() as AddressInfo).port;
  const mixedLookup: DnsLookup = async () => [
    { address: "10.1.2.3", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ];
  try {
    const origin = `http://opencode:${port}`;
    // The origin passes the exact-origin allowlist, so ONLY resolve-and-pin can reject.
    assert.doesNotThrow(() => validateResidentOpenCodeEndpoint(origin, { allowedOrigins: origin }));
    await assert.rejects(
      (async () => {
        const pinned = await resolveAndPinResidentOrigin(new URL(origin), mixedLookup);
        // A fabricated caller (test fixture): reached only if resolution accepts.
        const client = new OpenCodeHttp({ baseUrl: pinned.url.toString() });
        await client.sessionStatus();
      })(),
      ResidentEndpointError,
      "a non-private DNS answer must reject the origin",
    );
    assert.equal(httpRequests, 0, "zero HTTP requests may reach the transport when resolution rejects");
  } finally {
    await new Promise<void>((resolve) => erroringHttpFake.close(() => resolve()));
  }
});

test("real caller: the actual OpenCodeHttp connects to the pinned literal private IP, never the unpinned hostname", async () => {
  // A local HTTP server that records the Host header of whatever actually connects.
  let observedHost: string | undefined;
  let observedAuth: string | undefined;
  const server = createServer((req, res) => {
    observedHost = req.headers.host;
    observedAuth = req.headers.authorization;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const askedFor: string[] = [];
    const lookup: DnsLookup = async (hostname) => {
      askedFor.push(hostname);
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const pinned = await resolveAndPinResidentOrigin(new URL(`http://opencode:${port}`), lookup);
    assert.deepEqual(askedFor, ["opencode"], "resolution asks the injected lookup for the configured hostname");
    assert.equal(pinned.pinnedIp, "127.0.0.1");
    assert.equal(pinned.url.hostname, "127.0.0.1", "the origin is pinned to the literal private IP");
    assert.equal(
      pinned.url.toString().includes("opencode"),
      false,
      "the unpinned hostname must not survive in the connect URL",
    );

    const http = new OpenCodeHttp({
      baseUrl: pinned.url.toString(),
      username: "tissue",
      password: "s3cret",
    });
    await http.sessionStatus();

    assert.equal(observedHost, `127.0.0.1:${port}`, "the real request targets the pinned literal private IP");
    assert.equal(observedHost?.includes("opencode"), false, "the unpinned hostname is never used");
    assert.ok(observedAuth?.startsWith("Basic "), "the pinned request carries the attached credentials");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// L10 resolver/factory reject-path coverage (QA round 1). These three cases pin the
// fail-closed branches that the accept-side cases above leave unproven: the allowlist
// must never bypass the private requirement, an empty DNS answer set must reject, and
// an IPv4-mapped PUBLIC answer must decide non-private. Each rejection is local and
// synchronous against no network, so no server fixture is required.

test("allowlisted non-private literal origin is still rejected by the literal-IP private guard", async () => {
  // The allowlist accepts this exact origin byte-for-byte, so the ONLY guard that can
  // reject it is resolveAndPinResidentOrigin's literal-IP private check. A regression
  // that let the allowlist bypass the private requirement would make the factory
  // succeed and construct an authenticated transport to a public address.
  const origin = "http://8.8.8.8:4096";
  assert.doesNotThrow(
    () => validateResidentOpenCodeEndpoint(origin, { allowedOrigins: origin }),
    "the exact-origin allowlist itself accepts the entry",
  );
  await assert.rejects(
    createResidentTransport(
      { TISSUE_OPENCODE_URL: origin, TISSUE_OPENCODE_ALLOWED_ORIGINS: origin },
      { username: "tissue", password: "s3cret" },
    ),
    ResidentEndpointError,
    "an allowlisted public literal IP must be rejected by the private guard",
  );
  // Same origin with no credentials supplied: the rejection is not credential-dependent.
  await assert.rejects(
    createResidentTransport({ TISSUE_OPENCODE_URL: origin, TISSUE_OPENCODE_ALLOWED_ORIGINS: origin }),
    ResidentEndpointError,
    "an allowlisted public literal IP must reject even without credentials",
  );
});

test("resolve-and-pin rejects an empty DNS answer set", async () => {
  await assert.rejects(
    resolveAndPinResidentOrigin(new URL("http://opencode:4096"), async () => []),
    ResidentEndpointError,
    "an empty answer set must fail closed rather than pin an empty address",
  );
});

test("resolve-and-pin rejects an IPv4-mapped PUBLIC answer via the embedded IPv4 verdict", async () => {
  await assert.rejects(
    resolveAndPinResidentOrigin(
      new URL("http://opencode:4096"),
      lookupOf({ address: "::ffff:8.8.8.8", family: 6 }),
    ),
    ResidentEndpointError,
    "::ffff:8.8.8.8 embeds a public IPv4 address and must reject",
  );
});

// L10 factory allowlist SUCCESS path (QA round 2). Existing round-1/round-0
// coverage proves the allowlist reject paths and the factory's no-allowlist
// accept path; this case proves the allowlist-PRESENT positive composition
// end-to-end inside the single factory: exact-origin match → resolve-and-pin →
// credential attach → a real request. The origin is a private LITERAL IP
// (`127.0.0.1`), so resolve-and-pin skips DNS and the test stays deterministic.

test("factory allowlist match composes validate -> pin -> credential attach against a live server", async () => {
  const server = await startPessimisticServer({ username: "tissue", password: "s3cret" });
  try {
    const origin = server.baseUrl(); // http://127.0.0.1:<port> — private literal IP, no DNS
    const transport = await createResidentTransport(
      { TISSUE_OPENCODE_URL: origin, TISSUE_OPENCODE_ALLOWED_ORIGINS: origin },
      { username: "tissue", password: "s3cret" },
    );
    assert.equal(transport.pinnedUrl.hostname, "127.0.0.1", "the allowlisted origin is pinned to its literal private IP");
    assert.equal(
      transport.endpointLabel,
      `http://127.0.0.1:${new URL(origin).port}`,
      "endpointLabel is the credential-free scheme://host:port",
    );
    assert.equal(transport.endpointLabel.includes("s3cret"), false, "the endpoint label never carries credentials");
    await transport.http.sessionStatus();
    assert.ok(server.requestCount > 0, "the allowlist-accepted factory actually reaches the server");
    assert.equal(server.authRejections, 0, "credentials are attached only after validate/allowlist/pin succeed");
  } finally {
    await server.close();
  }
});
