export type IndexStatus =
    | "validating"
    | "loading_indexes"
    | "indexing_vault"
    | "indexing_changes"
    | "indexing_files"
    | "indexing_commands"
    | "indexing_headings"
    | "ready";

const STATUS_MESSAGES: Record<IndexStatus, string> = {
    validating: "Validating cached index…",
    loading_indexes: "Loading persisted indexes…",
    indexing_vault: "Building index from vault…",
    indexing_changes: "Applying changes to index…",
    indexing_files: "Indexing files…",
    indexing_commands: "Indexing commands…",
    indexing_headings: "Indexing headings…",
    ready: "Index ready.",
};

export class StatusBroadcaster {
	private lastStatus: IndexStatus | null = null;
	private readonly createNotice: ((message: string) => void) | null;
	private readonly logPrefix: string;
    private lastCounts: { files?: number } | null = null;

	constructor(options: { createNotice?: (message: string) => void; logPrefix?: string } = {}) {
		this.createNotice = options.createNotice ?? null;
		this.logPrefix = options.logPrefix ?? "[OmniSwitch]";
	}

	get status(): IndexStatus | null {
		return this.lastStatus;
	}

	getMessage(status: IndexStatus): string {
        if (status === "indexing_changes" && this.lastCounts?.files && this.lastCounts.files > 0) {
            return `${STATUS_MESSAGES[status]} (${this.lastCounts.files} items)`;
        }
        return STATUS_MESSAGES[status];
    }

	announce(status: IndexStatus, counts?: { files?: number }): void {
		this.lastCounts = counts ?? null;
		const message = this.getMessage(status);
		console.info(`${this.logPrefix} ${message}`);
		if (this.lastStatus === status) {
			return;
		}
		this.lastStatus = status;
		if (!this.createNotice) {
			return;
		}
		this.createNotice(message);
	}
}
