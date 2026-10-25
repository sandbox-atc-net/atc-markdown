// The open tabs, saved so they can be reopened on the next start.

import type { TabState } from "./tabs";

export interface Session {
  paths: string[];
  active: string | null;
}

export function toSession(state: TabState): Session {
  return {
    paths: state.tabs.map((tab) => tab.path),
    active: state.tabs[state.activeIndex]?.path ?? null,
  };
}

/** Parses a saved session, or returns `undefined` if it is missing or malformed. */
export function parseSession(raw: string | null): Session | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { paths, active } = value as Record<string, unknown>;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) return undefined;
  if (active !== null && typeof active !== "string") return undefined;
  return { paths: paths as string[], active };
}
