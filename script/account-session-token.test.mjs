import { describe, expect, it } from "vitest";

import {
  createAccountSessionToken,
  restoreAccountSessionToken,
} from "./account-session-token.mjs";

describe("signed account session tokens", () => {
  it("restores customer session claims without server memory", () => {
    const token = createAccountSessionToken({
      secret: "test-secret",
      issuedAt: 1781120000000,
      customer: {
        id: 72,
        email: "customer@example.com",
        firstName: "Royal",
        lastName: "Customer",
        phone: "083-851-1178",
      },
    });

    expect(token.startsWith("rps_")).toBe(true);
    expect(restoreAccountSessionToken(token, { secret: "test-secret" })).toEqual({
      customer: {
        id: 72,
        email: "customer@example.com",
        firstName: "Royal",
        lastName: "Customer",
        phone: "083-851-1178",
        billingAddress: {},
        shippingAddress: {},
        emailVerified: false,
      },
    });
  });

  it("rejects tampered or incorrectly signed tokens", () => {
    const token = createAccountSessionToken({
      secret: "test-secret",
      customer: { id: 72, email: "customer@example.com" },
    });

    expect(restoreAccountSessionToken(`${token}x`, { secret: "test-secret" })).toBe(
      null,
    );
    expect(restoreAccountSessionToken(token, { secret: "wrong-secret" })).toBe(null);
    expect(restoreAccountSessionToken("rp_legacy_random", { secret: "test-secret" })).toBe(
      null,
    );
  });
});
