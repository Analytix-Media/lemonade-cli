import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceLogin } from "../src/device.mjs";

function fakeServer(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/api/cli/device")) {
      return new Response(JSON.stringify({ device_code: "lmd_x", user_code: "BDKM-QTRS", verification_uri: "https://app/portal/cli", verification_uri_complete: "https://app/portal/cli?code=BDKM-QTRS", expires_in: 600, interval: 5 }), { status: 200 });
    }
    const next = answers.shift();
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { calls, fetchImpl };
}

test("waits while pending, slows down when told, and returns the token once approved", async () => {
  const { calls, fetchImpl } = fakeServer([
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down", interval: 10 } },
    { status: 200, body: { access_token: "lm_abc", token_type: "Bearer", site: { id: "st_1", name: "Bakery", address: "https://bakery" } } },
  ]);
  const waits = [];
  const lines = [];
  const got = await deviceLogin({ origin: "https://app", deviceName: "laptop", fetchImpl, wait: async (ms) => void waits.push(ms), say: (l) => lines.push(l) });
  assert.equal(got.token, "lm_abc");
  assert.equal(got.site.id, "st_1");
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.ok(lines.some((l) => l.includes("BDKM-QTRS")));
  assert.equal(calls[0].body.deviceName, "laptop");
  assert.equal(calls[1].body.device_code, "lmd_x");
});

test("a denial and an expiry stop with a sentence, never a token", async () => {
  for (const [error, words] of [["access_denied", "Not approved"], ["expired_token", "expired"]]) {
    const { fetchImpl } = fakeServer([{ status: 400, body: { error } }]);
    await assert.rejects(deviceLogin({ origin: "https://app", fetchImpl, wait: async () => {}, say: () => {} }), (e) => e.message.includes(words));
  }
});
