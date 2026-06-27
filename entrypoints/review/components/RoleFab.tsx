// Floating dev-only role switch (bottom-right). The parent decides whether
// to render this at all by gating on `DEV_ROLE_SWITCH` — this component
// itself has no opinion on env flags, which keeps it testable.

import type { Role } from "../reviewItems";

export type RoleFabProps = {
  role: Role;
  onChangeRole: (r: Role) => void;
};

export function RoleFab({ role, onChangeRole }: RoleFabProps) {
  return (
    <div className="role-fab" role="group" aria-label="Role (development)">
      <span className="role-fab__label">dev</span>
      <div className="seg seg--sm">
        <button
          type="button"
          aria-pressed={role === "author"}
          onClick={() => onChangeRole("author")}
        >
          author
        </button>
        <button
          type="button"
          aria-pressed={role === "reviewer"}
          onClick={() => onChangeRole("reviewer")}
        >
          reviewer
        </button>
      </div>
    </div>
  );
}
