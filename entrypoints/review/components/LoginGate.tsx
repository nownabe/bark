// Pre-authentication gate. Three screens: choose a method, the GitHub App
// device flow (state owned by App.tsx, passed in as props), and fine-grained
// PAT entry (validated here via lib/pat). The shared privacy note states the
// token lives only in this browser, common to both methods.
import { useRef, useState } from "react";
import type { DeviceAuthorization } from "../../../lib/auth";
import type { AuthMethod } from "../../../lib/storage";
import { validatePat } from "../../../lib/pat";

interface Props {
  owner: string;
  repo: string;
  prNum: string;
  deviceAuth: DeviceAuthorization | null;
  authStarting: boolean;
  authError: string | null;
  onStartDeviceFlow: () => void;
  onAuthenticated: (token: string, method: AuthMethod) => void | Promise<void>;
}

type Screen = "choose" | "app" | "pat";

const PAT_SETTINGS_URL = "https://github.com/settings/personal-access-tokens/new";

export function LoginGate({
  owner,
  repo,
  prNum,
  deviceAuth,
  authStarting,
  authError,
  onStartDeviceFlow,
  onAuthenticated,
}: Props) {
  const [screen, setScreen] = useState<Screen>("choose");
  const patRef = useRef<HTMLInputElement>(null);
  const [patError, setPatError] = useState<string | null>(null);
  const [patSubmitting, setPatSubmitting] = useState(false);

  const submitPat = async () => {
    const token = (patRef.current?.value ?? "").trim();
    setPatError(null);
    setPatSubmitting(true);
    try {
      await validatePat(token);
      await onAuthenticated(token, "pat");
    } catch (e) {
      setPatError(e instanceof Error ? e.message : "Could not validate the token.");
    } finally {
      setPatSubmitting(false);
    }
  };

  const brand = (
    <div className="gate__brand">
      <img className="gate__logo" src="/icon/128.png" alt="" />
      <h1>Bark</h1>
    </div>
  );

  const privacyNote = (
    <p className="notice--muted gate__privacy" style={{ fontSize: 12 }}>
      Whichever method you choose, the token is stored only in this browser (
      <code>chrome.storage.local</code>) and is never sent anywhere except GitHub.
    </p>
  );

  const back = (
    <button
      type="button"
      className="linkish gate__back"
      data-test="back"
      onClick={() => setScreen("choose")}
    >
      ← Choose a different method
    </button>
  );

  if (screen === "choose") {
    return (
      <div className="gate">
        {brand}
        <p>
          Connect Bark to open {owner}/{repo} #{prNum}.
        </p>
        <div className="gate__cards">
          <div className="gate__card">
            <div className="gate__card-head">
              <h2>GitHub App</h2>
              <span className="gate__badge">Recommended</span>
            </div>
            <ul className="gate__traits">
              <li>No expiry — access keeps working without renewal.</li>
              <li>Repository access is chosen when you install the app.</li>
              <li>Revoke anytime by uninstalling the app in GitHub settings.</li>
            </ul>
            <button
              type="button"
              className="btn btn--primary"
              data-test="choose-app"
              onClick={() => setScreen("app")}
            >
              Connect
            </button>
          </div>

          <div className="gate__card">
            <div className="gate__card-head">
              <h2>Token (PAT)</h2>
            </div>
            <ul className="gate__traits">
              <li>You set the expiry yourself when creating the token.</li>
              <li>No app installation needed.</li>
              <li>Repository access and permissions are chosen at creation.</li>
              <li>Revoke anytime by deleting the token in GitHub settings.</li>
            </ul>
            <button
              type="button"
              className="btn"
              data-test="choose-pat"
              onClick={() => setScreen("pat")}
            >
              Use →
            </button>
          </div>
        </div>
        {privacyNote}
      </div>
    );
  }

  if (screen === "app") {
    return (
      <div className="gate">
        {brand}
        {deviceAuth ? (
          <>
            <p>
              Authorize Bark for {owner}/{repo} #{prNum}. Enter this code on GitHub:
            </p>
            <div className="device-code">{deviceAuth.userCode}</div>
            <div className="gate__actions">
              <a
                className="btn btn--primary"
                href={deviceAuth.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                Open GitHub
              </a>
              <button
                type="button"
                className="btn"
                onClick={() => void navigator.clipboard?.writeText(deviceAuth.userCode)}
              >
                Copy code
              </button>
            </div>
            <p className="notice--muted" style={{ fontSize: 13 }}>
              Pick the repositories Bark may access, then approve. Keep this tab open — it continues
              automatically once you authorize.
            </p>
          </>
        ) : (
          <>
            <p>
              Authorize Bark with the device flow — there's no token to copy by hand. You choose
              which repositories Bark can access (<code>Contents</code> / <code>Pull requests</code>
              ).
            </p>
            {authError && (
              <p className="notice--error" style={{ fontSize: 13 }}>
                {authError}
              </p>
            )}
            <button
              type="button"
              className="btn btn--primary"
              onClick={onStartDeviceFlow}
              disabled={authStarting}
            >
              {authStarting ? "Starting…" : "Connect GitHub"}
            </button>
          </>
        )}
        {privacyNote}
        {back}
      </div>
    );
  }

  // screen === "pat"
  return (
    <div className="gate">
      {brand}
      <p>Paste a fine-grained personal access token.</p>
      <ol className="gate__steps">
        <li>
          Open{" "}
          <a href={PAT_SETTINGS_URL} target="_blank" rel="noreferrer">
            github.com/settings/personal-access-tokens/new
          </a>
          .
        </li>
        <li>
          Repository access → <strong>Only select repositories</strong>, and include {owner}/{repo}.
          You can select more repositories here to reuse one token across PRs.
        </li>
        <li>
          Permissions → <strong>Contents: Read and write</strong> and{" "}
          <strong>Pull requests: Read and write</strong>.
        </li>
        <li>Generate the token, copy it, and paste it below.</li>
      </ol>
      <input
        ref={patRef}
        type="password"
        className="gate__input"
        placeholder="github_pat_…"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !patSubmitting) void submitPat();
        }}
      />
      {patError && (
        <p className="notice--error" style={{ fontSize: 13 }}>
          {patError}
        </p>
      )}
      <div className="gate__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-test="pat-save"
          onClick={() => void submitPat()}
          disabled={patSubmitting}
        >
          {patSubmitting ? "Checking…" : "Save token"}
        </button>
      </div>
      {privacyNote}
      {back}
    </div>
  );
}
