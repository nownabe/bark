// Build-time env vars exposed to the bundle. The BARK_ prefix is allowlisted in
// wxt.config.ts (envPrefix); set values in .envrc.local (see .envrc.local.example).
interface ImportMetaEnv {
  /** Public client_id of the GitHub App used for the device flow (§7.6). */
  readonly BARK_GITHUB_CLIENT_ID?: string;
  /** Public slug of the GitHub App; builds its install URL for 404/403 (§7.6). */
  readonly BARK_GITHUB_APP_SLUG?: string;
}
