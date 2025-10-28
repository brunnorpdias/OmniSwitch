import type { App, WorkspaceLeaf } from "obsidian";

export type OmniSwitchMode = "files" | "commands" | "attachments" | "headings" | "directories";

export interface PrefixDetectionResult {
	mode: OmniSwitchMode;
	extensionFilter: string | null;
	search: string;
	prefixApplied: boolean;
}

const NOTE_EXTENSIONS = new Set(["md", "canvas", "base"]);

const ATTACHMENT_CATEGORIES: Record<string, string[]> = {
	obsidian: ["base", "canvas"],
	image: ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"],
	audio: ["flac", "m4a", "mp3", "ogg", "wav", "webm", "3gp"],
	video: ["mkv", "mov", "mp4", "ogv", "webm"],
};

export function detectPrefix(
    raw: string,
    currentMode: OmniSwitchMode,
    currentExtension: string | null,
): PrefixDetectionResult {
	if (currentMode !== "files") {
		return {
			mode: currentMode,
			extensionFilter: currentExtension,
			search: raw,
			prefixApplied: false,
		};
	}

	if (raw.startsWith("> ")) {
		return {
			mode: "commands",
			extensionFilter: null,
			search: raw.slice(2),
			prefixApplied: true,
		};
	}

	if (raw.startsWith("/ ")) {
		return {
			mode: "directories",
			extensionFilter: null,
			search: raw.slice(2),
			prefixApplied: true,
		};
	}

    if (raw.startsWith("# ")) {
        return {
            mode: "headings",
            extensionFilter: null,
            search: raw.slice(2),
            prefixApplied: true,
        };
    }

    // Attachment search: switch from legacy bang (!) to dot (.) prefix.
    // Examples: ". " → attachments (no filter); ".pdf <query>" → attachments filtered by extension/category
    if (raw.startsWith(".")) {
        const rest = raw.slice(1);
        if (rest.startsWith(" ")) {
            return {
                mode: "attachments",
                extensionFilter: null,
                search: rest.slice(1),
                prefixApplied: true,
            };
        }

        const firstSpace = rest.indexOf(" ");
        if (firstSpace === -1) {
            return {
                mode: currentMode,
                extensionFilter: currentExtension,
                search: raw,
                prefixApplied: false,
            };
        }

        const token = rest.slice(0, firstSpace).toLowerCase();
        const remainder = rest.slice(firstSpace + 1).trimStart();
        return {
            mode: "attachments",
            extensionFilter: token.startsWith(".") ? token.slice(1) : token,
            search: remainder,
            prefixApplied: true,
        };
    }

	return {
		mode: currentMode,
		extensionFilter: currentExtension,
		search: raw,
		prefixApplied: false,
	};
}

export function isNoteExtension(extension: string): boolean {
	return NOTE_EXTENSIONS.has(extension.toLowerCase());
}

export function matchesAttachmentExtension(extension: string, filter: string | null): boolean {
    const normalized = extension.toLowerCase();
    if (filter) {
        const category = ATTACHMENT_CATEGORIES[filter];
        if (category) {
            return category.includes(normalized);
        }
        const normalizedFilter = filter.startsWith(".") ? filter.slice(1) : filter;
        return normalized === normalizedFilter;
    }
    // Exclude extensionless files from attachments view
    if (!normalized) return false;
    return !NOTE_EXTENSIONS.has(normalized);
}

export function resolveAttachmentCategory(filter: string | null): string[] | null {
	if (!filter) {
		return null;
	}
	return ATTACHMENT_CATEGORIES[filter] ?? null;
}

export function getLeafFilePath(leaf: WorkspaceLeaf): string | null {
	const filePath = (leaf.view as { file?: { path: string } }).file?.path;
	if (filePath) {
		return filePath;
	}
	const state = leaf.getViewState();
	const stateFile = (state?.state as { file?: unknown } | undefined)?.file;
	return typeof stateFile === "string" ? stateFile : null;
}

export interface LeafDescriptor {
    leaf: WorkspaceLeaf;
    viewType: string;
    path: string | null;
}

const IGNORED_VIEW_TYPES = new Set([
	"backlink",
	"outgoing-link",
	"outline",
	"footnotes",
	"localgraph",
]);

export function collectFileLeaves(app: App): LeafDescriptor[] {
    const leaves: LeafDescriptor[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
        const viewType = leaf.view.getViewType();
        if (IGNORED_VIEW_TYPES.has(viewType)) {
            return;
        }
        const path = getLeafFilePath(leaf);
        if (!path) {
            return;
        }
        leaves.push({ leaf, viewType, path });
    });
    return leaves;
}

// --- Exclusion helpers (shared by index + modal) ---
export interface ExclusionMatcher {
    exact: string;
    prefix: string;
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function buildExclusionMatchers(paths: string[]): ExclusionMatcher[] {
    return paths.map((raw) => {
        const normalized = normalizePath(raw);
        const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
        return { exact: normalized, prefix };
    });
}

export function isExcluded(path: string, matchers: ExclusionMatcher[]): boolean {
    const normalized = normalizePath(path);
    return matchers.some((m) => normalized === m.exact || normalized.startsWith(m.prefix));
}
