/**
 * "Approve in the browser": how `lemonade login` (and a first `lemonade
 * deploy` with no token) gets a token without anyone pasting one. The
 * device code flow the app serves (lib/developer/device-login):
 *
 *   1. POST /api/cli/device -> a short code to show, and a page to approve it on
 *   2. the person approves it there, signed in, for ONE of their sites
 *   3. POST /api/cli/token every few seconds until it says yes, no, or expired
 *
 * The token that comes back can publish to that one site and read what is
 * live. It is saved to ~/.lemonade (0600), never printed.
 */

import os from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DeviceError extends Error {
  constructor(message) {
    super(message);
    this.expected = true;
  }
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Run the whole flow. `say` prints a line for the person (the AI assistant
 * running this relays it). Answers { token, site: {id, name, address} }.
 * `fetchImpl` and `now`/`wait` are seams for the tests.
 */
export async function deviceLogin({ origin, client = "cli", deviceName = os.hostname(), say = console.log, fetchImpl = fetch, wait = sleep, maxMs = 15 * 60_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${origin}/api/cli/device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client, deviceName: String(deviceName).slice(0, 60) }),
    });
  } catch (err) {
    throw new DeviceError(`Could not reach ${origin}.\n  ${err.message}`);
  }
  const start = await json(res);
  if (!res.ok || !start?.device_code) {
    throw new DeviceError(res.status === 429 ? "Too many sign-in attempts from here. Wait ten minutes, then try again." : `Could not start sign-in (HTTP ${res.status}).`);
  }

  say("");
  say("To let this computer publish, approve it in your browser:");
  say(`  1. Open   ${start.verification_uri_complete ?? start.verification_uri}`);
  say(`  2. Check the code says  ${start.user_code}`);
  say("  3. Pick your site and press Approve");
  say("");
  say("Waiting for you to approve...");

  let interval = Math.max(1, Number(start.interval) || 5);
  const deadline = Math.min(Number(start.expires_in) || 600, maxMs / 1000) * 1000;
  let waited = 0;
  while (waited < deadline) {
    await wait(interval * 1000);
    waited += interval * 1000;
    let poll;
    try {
      poll = await fetchImpl(`${origin}/api/cli/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code }),
      });
    } catch {
      continue; // a dropped connection is not an answer: ask again
    }
    const body = await json(poll);
    if (poll.ok && body?.access_token) return { token: body.access_token, site: body.site };
    const error = body?.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval = Math.max(interval + 5, Number(body?.interval) || 0);
      continue;
    }
    if (error === "access_denied") throw new DeviceError("Not approved. Nothing can publish from this computer.");
    if (error === "expired_token") throw new DeviceError("The code expired before it was approved. Run it again.");
    throw new DeviceError(`Sign-in stopped (${error ?? `HTTP ${poll.status}`}). Run it again.`);
  }
  throw new DeviceError("The code expired before it was approved. Run it again.");
}
