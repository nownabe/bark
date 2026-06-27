// Production wiring for useAuthFlow.
//
// Pulled into its own module so test code can import the hook from
// `useAuthFlow.ts` without dragging in the `wxt/browser` polyfill that
// `lib/storage` brings along (it throws when there is no extension
// runtime, e.g. in happy-dom).

import { pollForToken, requestDeviceAuthorization } from "../../../lib/auth";
import {
  clearToken,
  getAuthMethod,
  getToken,
  setAuthMethod as persistAuthMethod,
  setToken as persistToken,
} from "../../../lib/storage";
import type { AuthFlowDeps } from "./useAuthFlow";

export const productionAuthDeps: AuthFlowDeps = {
  getToken,
  getAuthMethod,
  persistToken,
  persistAuthMethod,
  clearStoredToken: clearToken,
  requestDeviceAuthorization,
  pollForToken,
};
