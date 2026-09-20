// Plan O Phase 1 spec-first contract for the container lint guard.
// These tests intentionally run before the production guard exists. The guard must
// reject unsafe Tissue Compose topology while accepting the internal wildcard
// listener when it is not published through `ports:`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check } from "../../scripts/lint.ts";

const checkCompose = (compose: string): string[] =>
  check("compose.yml", compose) as unknown as string[];

const tissue = (body: string): string => `
services:
  tissue:
${body}
`;

test("container guard exists and rejects at least one unsafe Tissue case", () => {
  assert.equal(typeof check, "function", "lint guard must remain callable/exported");
  const violations = checkCompose(tissue("    ports: [\"8787:8787\"]"));
  assert.ok(Array.isArray(violations), "guard must return inspectable violations");
  assert.ok(violations.length > 0, "a negative topology case must not be vacuous");
});

test("Tissue ports are rejected", () => {
  const violations = checkCompose(tissue([
    "    expose: [\"8787\"]",
    "    ports:",
    "      - \"8787:8787\"",
  ].join("\n")));
  assert.ok(violations.some((entry) => /tissue.*ports|ports.*tissue/i.test(entry)));
});

test("Tissue without expose is rejected", () => {
  const violations = checkCompose(tissue("    image: tissue:test"));
  assert.ok(violations.some((entry) => /tissue.*expose|expose.*tissue/i.test(entry)));
});

test("wildcard bind accompanied by ports is rejected", () => {
  const violations = checkCompose(tissue([
    "    expose: [\"8787\"]",
    "    command: [\"node\", \"health-server\"]",
    "    environment:",
    "      TISSUE_HTTP_BIND: \"0.0.0.0\"",
    "    ports:",
    "      - \"8787:8787\"",
  ].join("\n")));
  assert.ok(violations.some((entry) => /wildcard|ports|tissue/i.test(entry)));
});

test("wildcard bind without ports is accepted", () => {
  const violations = checkCompose(tissue([
    "    expose: [\"8787\"]",
    "    command: [\"node\", \"health-server\"]",
    "    environment:",
    "      TISSUE_HTTP_BIND: \"0.0.0.0\"",
  ].join("\n")));
  assert.deepEqual(violations, []);
});

test("the real repository Compose artifact passes the exported guard", () => {
  const root = resolve(import.meta.dirname, "../..");
  const compose = readFileSync(resolve(root, "compose.yml"), "utf8");
  assert.deepEqual(checkCompose(compose), []);
});

test("the guard rejects a real Compose artifact after an unsafe Tissue topology mutation", () => {
  const root = resolve(import.meta.dirname, "../..");
  const compose = readFileSync(resolve(root, "compose.yml"), "utf8");
  const unsafeCompose = compose.replace(
    '    expose:\n      - "8787"\n',
    '    expose:\n      - "8787"\n    ports:\n      - "8787:8787"\n',
  );
  assert.notEqual(unsafeCompose, compose, "fixture mutation must target the real Tissue service");

  const violations = checkCompose(unsafeCompose);
  assert.ok(
    violations.some((entry) => /compose\.yml: service 'tissue': ports are forbidden/.test(entry)),
    `real Compose mutation must be rejected by the exported guard: ${violations.join("; ")}`,
  );
});
