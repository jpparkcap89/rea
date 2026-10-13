import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const inspect = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  trackBrowser(browser);
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
    include_storage_keys: true,
    include_storage_fingerprints: true,
  });
  const capture = async () => {
    const result = await new CdpBrowserProvider().inspectPage(input);
    if (!result.ok) throw result.error;
    return result.value;
  };
  return { capture };
};

it.each([
  ["CacheStorage.requestCacheNames", {}],
  ["CacheStorage.requestCacheNames", { caches: null }],
  ["CacheStorage.requestCacheNames", { caches: [null] }],
  [
    "CacheStorage.requestCacheNames",
    { caches: [{ cacheName: "assets-v1", cacheId: "secret-id" }, null] },
  ],
  ["CacheStorage.requestCacheNames", { caches: [{ cacheName: "assets-v1" }] }],
  ["IndexedDB.requestDatabaseNames", { databaseNames: [null] }],
  ["DOMStorage.getDOMStorageItems", { entries: [null] }],
] as const)(
  "preserves unknown inventory coverage from %s: %j",
  async (method, reply) => {
    let malformed = false;
    const { capture } = await inspect({
      commandResult: (command) =>
        malformed && command.method === method ? reply : undefined,
    });
    const before = await capture();
    malformed = true;
    const after = await capture();
    expect(after.storage.fingerprints_complete).toBe(false);
    expect(after.completeness.unavailable_sections).toContain("storage_keys");
    expect(after.completeness.excluded).toContainEqual({
      section: "storage_keys",
      reason: "invalid_protocol_value",
      count: null,
    });
    const diff = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: before },
        after: { inspection: after },
      }),
    );
    expect(diff.dimensions.storage).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
  },
);

it("preserves unavailable storage-key coverage without requesting fingerprints", async () => {
  const browser = await startFakeCdpBrowser({
    unsupportedMethods: ["CacheStorage.requestCacheNames"],
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
      include_storage_keys: true,
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.completeness.excluded).toContainEqual({
    section: "storage_keys",
    reason: "provider_unavailable",
    count: null,
  });
  expect(result.value.storage.local_storage_keys).toEqual(["public-key"]);
});

const validKey = { type: "string", value: "row-1" };

it.each(["key", "primaryKey"])(
  "requires IndexedDB %s identity evidence",
  async (field) => {
    const { capture } = await inspect({
      commandResult: (command) =>
        command.method === "IndexedDB.requestData"
          ? {
              objectStoreDataEntries: [
                {
                  key: validKey,
                  primaryKey: validKey,
                  value: validKey,
                  [field]: {},
                },
              ],
              hasMore: false,
            }
          : undefined,
    });
    const captured = await capture();
    expect(captured.storage.fingerprints_complete).toBe(false);
    expect(
      captured.storage.content_fingerprints.find(
        ({ scope }) => scope === "indexed_db_record",
      )?.complete,
    ).toBe(false);
  },
);

it("does not fingerprint a filtered partial object-store schema as complete", async () => {
  let malformed = false;
  const store = {
    name: "records",
    keyPath: { type: "string", string: "id" },
    autoIncrement: false,
    indexes: [],
  };
  const { capture } = await inspect({
    commandResult: (command) =>
      command.method === "IndexedDB.requestDatabase"
        ? {
            databaseWithObjectStores: {
              name: "app-db",
              version: 1,
              objectStores: [
                store,
                malformed ? null : { ...store, name: "other" },
              ],
            },
          }
        : undefined,
  });
  const before = await capture();
  malformed = true;
  const after = await capture();
  expect(
    after.storage.content_fingerprints.find(
      ({ scope }) => scope === "indexed_db_schema",
    )?.complete,
  ).toBe(false);
  const diff = compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  );
  expect(diff.dimensions.storage).toMatchObject({
    status: "unknown",
    total_changes: 0,
  });
});

it.each([
  undefined,
  null,
  "raw",
  {},
  { type: "string" },
  { type: "string", value: 1 },
  { type: "boolean", value: "false" },
  { type: "number" },
  { type: "number", unserializableValue: "invalid" },
  { type: "number", unserializableValue: ["NaN"] },
  { type: "function", description: "function f() {}" },
  { type: "symbol", description: "Symbol(x)" },
  { type: "object", subtype: "null" },
  { type: "bigint", unserializableValue: "broken" },
])(
  "marks incomplete IndexedDB RemoteObject values unknown: %j",
  async (value) => {
    const { capture } = await inspect({
      commandResult: (command) =>
        command.method === "IndexedDB.requestData"
          ? {
              objectStoreDataEntries: [
                { key: validKey, primaryKey: validKey, value },
              ],
              hasMore: false,
            }
          : undefined,
    });
    const before = await capture();
    const after = await capture();
    const records = before.storage.content_fingerprints.filter(
      ({ scope }) => scope === "indexed_db_record",
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.complete).toBe(false);
    expect(before.storage.fingerprints_complete).toBe(false);
    const diff = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: before },
        after: { inspection: after },
      }),
    );
    expect(diff.dimensions.storage).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
  },
);

it.each([
  { type: "string", value: "" },
  { type: "boolean", value: false },
  { type: "number", value: 0 },
  { type: "undefined" },
  { type: "number", unserializableValue: "NaN" },
  { type: "number", unserializableValue: "-0" },
  { type: "bigint", unserializableValue: "-42n" },
  { type: "object", subtype: "null", value: null },
  { type: "object", value: { nested: [false, null, 0] } },
])("retains complete by-value IndexedDB data: %j", async (value) => {
  const { capture } = await inspect({
    commandResult: (command) =>
      command.method === "IndexedDB.requestData"
        ? {
            objectStoreDataEntries: [
              { key: validKey, primaryKey: validKey, value },
            ],
            hasMore: false,
          }
        : undefined,
  });
  const captured = await capture();
  expect(captured.storage.fingerprints_complete).toBe(true);
});

it.each([
  [undefined, false],
  [{}, false],
  [{ type: "string" }, false],
  [{ type: "array", array: [null] }, false],
  [{ type: "null" }, true],
  [{ type: "string", string: "id" }, true],
  [{ type: "array", array: ["id", "name"] }, true],
] as const)(
  "requires complete IndexedDB key paths: %j",
  async (keyPath, complete) => {
    const { capture } = await inspect({
      commandResult: (command) =>
        command.method === "IndexedDB.requestDatabase"
          ? {
              databaseWithObjectStores: {
                name: "app-db",
                version: 1,
                objectStores: [
                  {
                    name: "records",
                    keyPath,
                    autoIncrement: false,
                    indexes: [
                      {
                        name: "by-id",
                        keyPath,
                        unique: false,
                        multiEntry: false,
                      },
                    ],
                  },
                ],
              },
            }
          : undefined,
    });
    const captured = await capture();
    expect(
      captured.storage.content_fingerprints.find(
        ({ scope }) => scope === "indexed_db_schema",
      )?.complete,
    ).toBe(complete);
    expect(captured.storage.fingerprints_complete).toBe(complete);
  },
);

it("accepts genuinely empty inventories as complete", async () => {
  const { capture } = await inspect({
    commandResult: (command) => {
      switch (command.method) {
        case "CacheStorage.requestCacheNames":
          return { caches: [] };
        case "IndexedDB.requestDatabaseNames":
          return { databaseNames: [] };
        case "DOMStorage.getDOMStorageItems":
          return { entries: [] };
        case "Network.getCookies":
          return { cookies: [] };
        default:
          return undefined;
      }
    },
  });
  const before = await capture();
  const after = await capture();
  expect(before.storage.fingerprints_complete).toBe(true);
  const diff = compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  );
  expect(diff.dimensions.storage.status).toBe("unchanged");
});
