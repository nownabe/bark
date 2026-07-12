// Sidebar-level Review / History segmented switch. Toggles the sidebar
// between the live review list and the read-only round-history panel.
// Pure presentation — reuses the shared `.seg` control (see design.md §3).

export type SidebarView = "review" | "history";

export type SidebarViewSwitchProps = {
  view: SidebarView;
  onChange: (view: SidebarView) => void;
};

const VIEWS: { key: SidebarView; label: string }[] = [
  { key: "review", label: "Review" },
  { key: "history", label: "History" },
];

export function SidebarViewSwitch({ view, onChange }: SidebarViewSwitchProps) {
  return (
    <div className="seg seg--sm">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          aria-pressed={view === v.key}
          onClick={() => onChange(v.key)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
