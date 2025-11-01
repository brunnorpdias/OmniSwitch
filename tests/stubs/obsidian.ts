export const Platform = {
	isDesktopApp: true,
	isMobileApp: false,
};

export class TFile {
	path = "";
	basename = "";
	extension = "md";
	parent: { path: string } | null = null;
	stat = { mtime: 0, ctime: 0 };
}

export class App {
	vault: unknown = {};
	metadataCache: unknown = {};
}

export type CachedMetadata = Record<string, unknown>;
