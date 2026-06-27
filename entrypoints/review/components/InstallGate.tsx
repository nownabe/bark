// Install / access gate. Rendered when the initial PR load fails with
// 404 / 403 — most often the Bark GitHub App is not installed on the
// repository (auth method "app"), or the PAT lacks the right permissions
// (auth method "pat"). Two distinct CTAs depending on which one we hit.

import type { AuthMethod } from "../../../lib/storage";

export type InstallGateProps = {
  owner: string | null;
  repo: string | null;
  prNum: string | null;
  authMethod: AuthMethod | null;
  loading: boolean;
  /** Falsy when no `BARK_GITHUB_APP_SLUG` env is configured at build time. */
  installUrl: string | null;
  onRetry: () => void;
  onClearToken: () => void;
};

export function InstallGate({
  owner,
  repo,
  prNum,
  authMethod,
  loading,
  installUrl,
  onRetry,
  onClearToken,
}: InstallGateProps) {
  return (
    <div className="gate">
      <div className="gate__brand">
        <img className="gate__logo" src="/icon/128.png" alt="" />
        <h1>Bark</h1>
      </div>
      <p>
        Bark can't open {owner}/{repo} #{prNum} yet.
      </p>
      {authMethod === "pat" ? (
        <>
          <p className="notice--muted" style={{ fontSize: 13 }}>
            This token can't access {owner}/{repo}. Check the token's repository access and its{" "}
            <code>Contents</code> / <code>Pull requests</code> permissions, then retry — or use a
            different token.
          </p>
          <div className="gate__actions">
            <button type="button" className="btn btn--primary" onClick={onRetry} disabled={loading}>
              {loading ? "Checking…" : "Retry"}
            </button>
            <button type="button" className="btn" onClick={onClearToken}>
              Use a different token
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="notice--muted" style={{ fontSize: 13 }}>
            You're authorized, but Bark isn't installed on this repository (or the repository / PR
            doesn't exist). Install Bark and select this repository, then retry.
          </p>
          <div className="gate__actions">
            {installUrl ? (
              <a className="btn btn--primary" href={installUrl} target="_blank" rel="noreferrer">
                Install on this repository
              </a>
            ) : null}
            <button type="button" className="btn" onClick={onRetry} disabled={loading}>
              {loading ? "Checking…" : "Retry"}
            </button>
          </div>
          <p className="notice--muted" style={{ fontSize: 12 }}>
            Authorized as the wrong account?{" "}
            <button type="button" className="linkish" onClick={onClearToken}>
              Use a different account
            </button>
          </p>
        </>
      )}
    </div>
  );
}
