import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import { checkFrugalMode } from "./spend-guard.js";

describe("checkFrugalMode", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restoreAll();
  });

  it("solo par défaut active le mode frugal sans appel spend API", async () => {
    const fetchSpy = mock.fn<typeof fetch>();
    global.fetch = fetchSpy as typeof fetch;
    const frugal = await checkFrugalMode({
      CURSOR_API_KEY: "cur_x",
      CURSOR_BILLING_MODE: "solo",
      SPEND_ALERT_CENTS: "100",
    });
    assert.strictEqual(frugal, true);
    assert.strictEqual(fetchSpy.mock.callCount(), 0);
  });

  it("FRUGAL_DEFAULT=false force le mode non frugal même en solo", async () => {
    const frugal = await checkFrugalMode({
      CURSOR_BILLING_MODE: "solo",
      FRUGAL_DEFAULT: "false",
      SPEND_ALERT_CENTS: "100",
      CURSOR_API_KEY: "cur_x",
    });
    assert.strictEqual(frugal, false);
  });

  it("team + seuil dépassé active frugal", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          teamMemberSpend: [{ email: "a@b.c", overallSpendCents: 900 }],
        }),
        { status: 200 },
      )) as typeof fetch;

    const frugal = await checkFrugalMode({
      CURSOR_BILLING_MODE: "team",
      SPEND_ALERT_CENTS: "800",
      CURSOR_API_KEY: "cur_x",
    });
    assert.strictEqual(frugal, true);
  });

  it("team sans SPEND_ALERT_CENTS laisse frugal off", async () => {
    const frugal = await checkFrugalMode({
      CURSOR_BILLING_MODE: "team",
      CURSOR_API_KEY: "cur_x",
    });
    assert.strictEqual(frugal, false);
  });
});
