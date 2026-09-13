/** Which screen is up. Four are tabs; the player and the editor are detail views the library
 *  pushes, so they are routes rather than tabs. */

export type Tab = "library" | "matches" | "storage" | "settings";
export type Route =
  | { view: Exclude<Tab, "matches"> }
  | { view: "matches"; session?: number; match?: number }
  | { view: "player"; id: number }
  | { view: "editor"; id: number };

let route: Route = { view: "library" };
const listeners: ((r: Route) => void)[] = [];

export function current(): Route {
  return route;
}

/** The tab that stays lit: the player and the editor belong to the library. */
export function activeTab(): Tab {
  return route.view === "player" || route.view === "editor" ? "library" : route.view;
}

export function go(next: Route): void {
  route = next;
  for (const fn of listeners) fn(route);
}

export function onRoute(fn: (r: Route) => void): void {
  listeners.push(fn);
}
