// Turns one Cua Driver get_window_state snapshot into Jev candidates, the way
// Cua's jev-use example does: only enabled, labeled, interactive native
// controls; window chrome excluded; the deny list enforced before Jev is asked.

export type RoleClass = "button" | "toggle" | "checkbox" | "radio" | "popup" | "menu_item" | "link" | "text_input" | "tab" | "list_item";

export interface DriverElement {
  role?: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  element_token?: string;
  in_web_content?: boolean;
  frame?: unknown;
  parent?: number;
  index?: number;
}

export interface Candidate {
  id: string;
  description: string;
  roleClass: RoleClass;
  label: string;
  elementToken: string;
}

function normalizedRole(role: string | undefined): string {
  let normalized = (role ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (normalized.startsWith("ax")) normalized = normalized.slice(2);
  if (normalized === "pushbutton") normalized = "button";
  if (normalized === "pagetab" || normalized === "tabitem") normalized = "tab";
  return normalized;
}

// UIA control types on Windows, AX roles on macOS, AT-SPI names on Linux, all normalized.
const roleClassByNormalizedRole: Record<string, RoleClass> = {
  button: "button",
  splitbutton: "button",
  menubutton: "popup",
  switch: "toggle",
  togglebutton: "toggle",
  checkbox: "checkbox",
  checkmenuitem: "menu_item",
  radiobutton: "radio",
  popupbutton: "popup",
  combobox: "popup",
  menuitem: "menu_item",
  menubaritem: "menu_item",
  hyperlink: "link",
  link: "link",
  edit: "text_input",
  textfield: "text_input",
  textarea: "text_input",
  searchfield: "text_input",
  securetextfield: "text_input",
  tab: "tab",
  listitem: "list_item",
  treeitem: "list_item",
};

const windowChromeLabels = new Set(["minimize", "maximize", "restore", "close", "system", "system menu"]);

export function roleClassFor(role: string | undefined): RoleClass | undefined {
  return roleClassByNormalizedRole[normalizedRole(role)];
}

export function isDenied(label: string, denyList: string[]): boolean {
  const lowered = label.toLowerCase();
  return denyList.some((denied) => denied.trim() && lowered.includes(denied.trim().toLowerCase()));
}

export function buildCandidates(elements: DriverElement[], goal: string, denyList: string[], limit = 24): Candidate[] {
  const goalWords = new Set(goal.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const eligible: (Candidate & { order: number; overlap: number })[] = [];
  const usedIds = new Map<string, number>();
  elements.forEach((element, order) => {
    const roleClass = roleClassFor(element.role);
    const label = (element.label ?? "").trim();
    if (!roleClass || !label || !element.element_token) return;
    if (element.enabled === false) return;
    if (element.value && element.value.trim() === label && roleClass !== "text_input") return;
    if (windowChromeLabels.has(label.toLowerCase())) return;
    if (isDenied(label, denyList)) return;
    const baseId = `${roleClass}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "unnamed"}`;
    const seen = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, seen + 1);
    const id = seen === 0 ? baseId : `${baseId}_${seen + 1}`;
    const state = roleClass === "text_input" ? (element.value ? " (has text)" : " (empty)") : "";
    const overlap = label.toLowerCase().split(/[^a-z0-9]+/).filter((word) => goalWords.has(word)).length;
    eligible.push({ id, description: `${roleClass} "${label}"${state}`, roleClass, label, elementToken: element.element_token, order, overlap });
  });
  // Keep the controls that share words with the goal first, then the rest in element order.
  const kept = [...eligible].sort((left, right) => right.overlap - left.overlap || left.order - right.order).slice(0, limit);
  return kept.sort((left, right) => left.order - right.order).map(({ order: _order, overlap: _overlap, ...candidate }) => candidate);
}
