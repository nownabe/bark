// GitHub App Device Flow — Design Doc §7.6 / decision D10 (v2 auth).
//
// We acquire a non-expiring user-to-server token via the OAuth device flow:
// the user authorizes a GitHub App (client_id only, no secret) and picks which
// repositories Bark may access. The resulting bearer token is fed to
// GitHubClient unchanged.
//
// The device-flow endpoints live on github.com and return no CORS headers, so
// the actual fetches run in the background service worker (it bypasses CORS for
// hosts in host_permissions). This module is the page-side client: it drives the
// flow by message-passing to the worker. Token persistence stays in storage.ts.
import { browser } from "wxt/browser";

/** Device authorization grant returned by github.com/login/device/code. */
export interface DeviceAuthorization {
  /** Opaque code the page polls with (never shown to the user). */
  deviceCode: string;
  /** Short code the user types into github.com (shown in the UI). */
  userCode: string;
  /** Where the user enters userCode (e.g. https://github.com/login/device). */
  verificationUri: string;
  /** Seconds until deviceCode expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

/** Page → worker: request a fresh device + user code. */
export interface DeviceCodeMessage {
  type: "bark/auth/device-code";
}
/** Page → worker: exchange a device code for a token (one poll). */
export interface TokenMessage {
  type: "bark/auth/token";
  deviceCode: string;
}

// Worker → page payloads. snake_case mirrors GitHub's JSON verbatim; the worker
// forwards the parsed body (or a {error} shape on a config/transport problem).
interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}
interface TokenResponse {
  access_token?: string;
  // authorization_pending | slow_down | expired_token | access_denied | ...
  error?: string;
  error_description?: string;
  interval?: number;
}

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

/** Step 1: request a device + user code from GitHub. */
export async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const res = (await browser.runtime.sendMessage({
    type: "bark/auth/device-code",
  } satisfies DeviceCodeMessage)) as DeviceCodeResponse | undefined;
  if (!res || res.error || !res.device_code || !res.user_code || !res.verification_uri) {
    throw new DeviceFlowError(
      res?.error_description || res?.error || "Could not start GitHub authorization.",
    );
  }
  return {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUri: res.verification_uri,
    expiresIn: res.expires_in ?? 900,
    interval: res.interval ?? 5,
  };
}

export type PollOutcome =
  | { kind: "authorized"; token: string }
  | { kind: "pending" }
  | { kind: "slow_down"; interval: number };

/**
 * Step 2 (single poll): exchange the device code for a token. The transient
 * `authorization_pending` / `slow_down` states are returned so the caller can
 * keep polling; any terminal failure (expired_token, access_denied, …) throws.
 */
export async function pollForToken(deviceCode: string): Promise<PollOutcome> {
  const res = (await browser.runtime.sendMessage({
    type: "bark/auth/token",
    deviceCode,
  } satisfies TokenMessage)) as TokenResponse | undefined;
  if (res?.access_token) return { kind: "authorized", token: res.access_token };
  switch (res?.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down", interval: res.interval ?? 5 };
    case "expired_token":
      throw new DeviceFlowError("The code expired before you authorized. Please try again.");
    case "access_denied":
      throw new DeviceFlowError("Authorization was denied.");
    default:
      throw new DeviceFlowError(
        res?.error_description || res?.error || "GitHub authorization failed.",
      );
  }
}
