import test from "node:test";
import assert from "node:assert/strict";
import { pruneExpiredRequests } from "../rate-limit.js";

test("pruneExpiredRequests removes expired clients and keeps active ones", () => {
  const requests = new Map([
    ["expired", { startedAt: 1_000, count: 4 }],
    ["active", { startedAt: 59_999, count: 2 }]
  ]);

  pruneExpiredRequests(requests, 61_000, 60_000);

  assert.deepEqual([...requests], [["active", { startedAt: 59_999, count: 2 }]]);
});
