// Minimal shared model for journal + manager

export interface PersistedHeadingEntry {
  text: string;
  level: number;
}

export interface PersistedFileEntry {
  path: string;
  extension: string;
  modified: number;
  size: number;
  headings: PersistedHeadingEntry[];
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

