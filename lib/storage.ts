// Local storage layer — Design Doc §7.7.
//  - chrome.storage.local: token, settings, lightweight metadata
//  - IndexedDB: per-PR pending comments/suggestions, snapshots, position-map cache
// Scaffold: key helpers only;实装は後続スライス。

/** IndexedDB / storage キー設計 (§7.7): pr:{owner}/{repo}#{number} 配下に下書き群。 */
export const storageKeys = {
  pr: (owner: string, repo: string, number: number | string) =>
    `pr:${owner}/${repo}#${number}`,
};
