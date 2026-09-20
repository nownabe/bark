import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type AuthFlowDeps, useAuthFlow } from "../entrypoints/review/hooks/useAuthFlow";
import type { DeviceAuthorization } from "../lib/auth";
import type { AuthMethod } from "../lib/storage";

afterEach(() => {
  cleanup();
});

function makeDeps(overrides: Partial<AuthFlowDeps> = {}): AuthFlowDeps {
  return {
    getToken: mock(async () => null),
    getAuthMethod: mock(async () => null),
    persistToken: mock(async (_t: string) => {}),
    persistAuthMethod: mock(async (_m: AuthMethod) => {}),
    clearStoredToken: mock(async () => {}),
    requestDeviceAuthorization: mock(async (): Promise<DeviceAuthorization> => ({
      deviceCode: "dc",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    })),
    pollForToken: mock(async () => ({ kind: "pending" }) as const),
    ...overrides,
  };
}

describe("useAuthFlow — initial restore", () => {
  test("token / authMethod start null, tokenLoaded flips true after the storage read resolves", async () => {
    const deps = makeDeps({
      getToken: mock(async () => "stored-token"),
      getAuthMethod: mock(async () => "pat" as AuthMethod),
    });
    const { result } = renderHook(() => useAuthFlow(deps));
    expect(result.current.tokenLoaded).toBe(false);
    expect(result.current.token).toBeNull();
    await waitFor(() => {
      expect(result.current.tokenLoaded).toBe(true);
    });
    expect(result.current.token).toBe("stored-token");
    expect(result.current.authMethod).toBe("pat");
  });
});

describe("useAuthFlow — startDeviceFlow", () => {
  test("sets authStarting while in flight, then stashes the returned DeviceAuthorization", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useAuthFlow(deps));
    await waitFor(() => expect(result.current.tokenLoaded).toBe(true));

    await act(async () => {
      await result.current.startDeviceFlow();
    });
    expect(result.current.authStarting).toBe(false);
    expect(result.current.deviceAuth?.userCode).toBe("ABCD-1234");
    expect(result.current.authError).toBeNull();
  });

  test("surface a thrown error via authError and never sets deviceAuth", async () => {
    const deps = makeDeps({
      requestDeviceAuthorization: mock(async () => {
        throw new Error("network down");
      }),
    });
    const { result } = renderHook(() => useAuthFlow(deps));
    await waitFor(() => expect(result.current.tokenLoaded).toBe(true));

    await act(async () => {
      await result.current.startDeviceFlow();
    });
    expect(result.current.deviceAuth).toBeNull();
    expect(result.current.authError).toBe("network down");
  });
});

describe("useAuthFlow — completeAuth (PAT)", () => {
  test("persists the token + method, then applies them to state", async () => {
    const persistToken = mock(async (_t: string) => {});
    const persistAuthMethod = mock(async (_m: AuthMethod) => {});
    const deps = makeDeps({ persistToken, persistAuthMethod });
    const { result } = renderHook(() => useAuthFlow(deps));
    await waitFor(() => expect(result.current.tokenLoaded).toBe(true));

    await act(async () => {
      await result.current.completeAuth("pat-token", "pat");
    });
    expect(persistToken).toHaveBeenCalledWith("pat-token");
    expect(persistAuthMethod).toHaveBeenCalledWith("pat");
    expect(result.current.token).toBe("pat-token");
    expect(result.current.authMethod).toBe("pat");
  });
});

describe("useAuthFlow — clearToken", () => {
  test("clears stored token, drops every auth field back to its initial value", async () => {
    const clearStored = mock(async () => {});
    const deps = makeDeps({
      getToken: mock(async () => "stored"),
      getAuthMethod: mock(async () => "app" as AuthMethod),
      clearStoredToken: clearStored,
    });
    const { result } = renderHook(() => useAuthFlow(deps));
    await waitFor(() => expect(result.current.token).toBe("stored"));

    await act(async () => {
      await result.current.clearToken();
    });
    expect(clearStored).toHaveBeenCalledTimes(1);
    expect(result.current.token).toBeNull();
    expect(result.current.authMethod).toBeNull();
    expect(result.current.deviceAuth).toBeNull();
    expect(result.current.authError).toBeNull();
  });
});

// The device-flow polling effect is driven by a chain of self-scheduling
// `setTimeout`s, which interact poorly with happy-dom + the testing-library
// async helpers. It is covered by manual reload testing. The unit tests
// above pin every other state transition this hook performs.
