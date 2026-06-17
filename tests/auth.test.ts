import { afterEach, describe, expect, mock, test } from "bun:test";

// The device-flow client message-passes to the background worker; mock that
// channel so we can drive each branch of the response handling.
let nextResponse: unknown;
mock.module("wxt/browser", () => ({
  browser: { runtime: { sendMessage: async () => nextResponse } },
}));

const { requestDeviceAuthorization, pollForToken, DeviceFlowError } = await import("../lib/auth");

afterEach(() => {
  nextResponse = undefined;
});

describe("requestDeviceAuthorization", () => {
  test("normalizes a successful grant", async () => {
    nextResponse = {
      device_code: "dc",
      user_code: "WXYZ-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    };
    expect(await requestDeviceAuthorization()).toEqual({
      deviceCode: "dc",
      userCode: "WXYZ-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
  });

  test("applies defaults when expires_in/interval are absent", async () => {
    nextResponse = {
      device_code: "dc",
      user_code: "WXYZ-1234",
      verification_uri: "https://github.com/login/device",
    };
    const auth = await requestDeviceAuthorization();
    expect(auth.expiresIn).toBe(900);
    expect(auth.interval).toBe(5);
  });

  test("throws on an error payload", async () => {
    nextResponse = { error: "config_error", error_description: "no client id" };
    await expect(requestDeviceAuthorization()).rejects.toThrow("no client id");
  });

  test("throws on a malformed (incomplete) payload", async () => {
    nextResponse = { device_code: "dc" };
    await expect(requestDeviceAuthorization()).rejects.toThrow(DeviceFlowError);
  });
});

describe("pollForToken", () => {
  test("authorized returns the token", async () => {
    nextResponse = { access_token: "ghu_token" };
    expect(await pollForToken("dc")).toEqual({ kind: "authorized", token: "ghu_token" });
  });

  test("authorization_pending maps to pending", async () => {
    nextResponse = { error: "authorization_pending" };
    expect(await pollForToken("dc")).toEqual({ kind: "pending" });
  });

  test("slow_down carries the new interval", async () => {
    nextResponse = { error: "slow_down", interval: 10 };
    expect(await pollForToken("dc")).toEqual({ kind: "slow_down", interval: 10 });
  });

  test("expired_token throws", async () => {
    nextResponse = { error: "expired_token" };
    await expect(pollForToken("dc")).rejects.toThrow(DeviceFlowError);
  });

  test("access_denied throws", async () => {
    nextResponse = { error: "access_denied" };
    await expect(pollForToken("dc")).rejects.toThrow("denied");
  });
});
