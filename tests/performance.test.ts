import { describe, it, expect, beforeEach } from "vitest";
import { FuseEngine, type MinimalFileDoc, type MinimalHeadingDoc } from "../src/search/engines/fuse-engine";
import { MiniSearchEngine } from "../src/search/engines/mini-engine";

/**
 * Performance Tests for Search Engines
 *
 * These tests measure and validate performance characteristics of the search engines.
 * Target metrics:
 * - Index building: <5s for 2M headings
 * - Search: <100ms for 2M headings
 * - Resolution: <50ms for 20 results
 */

// Helper to generate synthetic test data
function generateFiles(count: number): MinimalFileDoc[] {
    const files: MinimalFileDoc[] = [];
    for (let i = 0; i < count; i++) {
        files.push({
            id: `folder${i % 100}/file${i}.md`,
            name: `file${i}.md`,
            extension: "md",
            mtime: Date.now()
        });
    }
    return files;
}

function generateHeadings(count: number): MinimalHeadingDoc[] {
    const headings: MinimalHeadingDoc[] = [];
    const titles = [
        "Introduction", "Overview", "Getting Started", "Tutorial",
        "Advanced Topics", "API Reference", "Configuration", "Examples",
        "Troubleshooting", "FAQ", "Best Practices", "Architecture"
    ];

    for (let i = 0; i < count; i++) {
        const fileIndex = Math.floor(i / 10); // 10 headings per file
        const headingIndex = i % 10;
        const title = `${titles[i % titles.length]} ${headingIndex}`;

        headings.push({
            id: `folder${fileIndex % 100}/file${fileIndex}.md::${headingIndex}`,
            title: title
        });
    }
    return headings;
}

describe("Search Engine Performance", () => {
    describe("Index Building", () => {
        it("Fuse should build 10k file index in <500ms", () => {
            const files = generateFiles(10000);
            const engine = new FuseEngine();

            const start = performance.now();
            engine.setFiles(files);
            const duration = performance.now() - start;

            console.log(`[Perf] Fuse file index (10k): ${duration.toFixed(1)}ms`);
            expect(duration).toBeLessThan(500);
        });

        it("Mini should build 10k file index in <500ms", () => {
            const files = generateFiles(10000);
            const engine = new MiniSearchEngine();

            const start = performance.now();
            engine.setFiles(files);
            const duration = performance.now() - start;

            console.log(`[Perf] Mini file index (10k): ${duration.toFixed(1)}ms`);
            expect(duration).toBeLessThan(500);
        });

        it("Fuse should build 100k heading index in <2s", () => {
            const headings = generateHeadings(100000);
            const engine = new FuseEngine();

            const start = performance.now();
            engine.setHeadings(headings);
            const duration = performance.now() - start;

            console.log(`[Perf] Fuse heading index (100k): ${duration.toFixed(1)}ms`);
            expect(duration).toBeLessThan(2000);
        });

        it("Mini should build 100k heading index in <2s (async)", async () => {
            const headings = generateHeadings(100000);
            const engine = new MiniSearchEngine();

            const start = performance.now();
            await engine.setHeadingsAsync(headings);
            const duration = performance.now() - start;

            console.log(`[Perf] Mini heading index (100k async): ${duration.toFixed(1)}ms`);
            expect(duration).toBeLessThan(2000);
        });

        // Stress test with 1M headings (close to real-world large vaults)
        it("Mini should build 1M heading index in <15s (async)", async () => {
            const headings = generateHeadings(1000000);
            const engine = new MiniSearchEngine();

            const start = performance.now();
            await engine.setHeadingsAsync(headings);
            const duration = performance.now() - start;

            console.log(`[Perf] Mini heading index (1M async): ${duration.toFixed(1)}ms (${(duration/1000).toFixed(1)}s)`);
            expect(duration).toBeLessThan(15000);
        }, 30000); // 30s timeout for this test
    });

    describe("Search Performance", () => {
        let fuseFiles: FuseEngine;
        let miniFiles: MiniSearchEngine;
        let fuseHeadings: FuseEngine;
        let miniHeadings: MiniSearchEngine;

        beforeEach(() => {
            // Build indexes once for all search tests
            const files = generateFiles(10000);
            const headings = generateHeadings(100000);

            fuseFiles = new FuseEngine();
            fuseFiles.setFiles(files);

            miniFiles = new MiniSearchEngine();
            miniFiles.setFiles(files);

            fuseHeadings = new FuseEngine();
            fuseHeadings.setHeadings(headings);

            miniHeadings = new MiniSearchEngine();
            miniHeadings.setHeadings(headings);
        });

        it("Fuse file search (10k) should complete in <100ms", () => {
            const queries = ["file", "test", "document", "folder"];

            for (const query of queries) {
                const start = performance.now();
                const results = fuseFiles.searchFiles(query, 20);
                const duration = performance.now() - start;

                console.log(`[Perf] Fuse file search "${query}": ${duration.toFixed(1)}ms (${results.length} results)`);
                expect(duration).toBeLessThan(100);
            }
        });

        it("Mini file search (10k) should complete in <100ms", () => {
            const queries = ["file", "test", "document", "folder"];

            for (const query of queries) {
                const start = performance.now();
                const results = miniFiles.searchFiles(query, 20);
                const duration = performance.now() - start;

                console.log(`[Perf] Mini file search "${query}": ${duration.toFixed(1)}ms (${results.length} results)`);
                expect(duration).toBeLessThan(100);
            }
        });

        it("Fuse heading search (100k) should complete in <200ms", () => {
            const queries = ["introduction", "overview", "getting", "advanced"];

            for (const query of queries) {
                const start = performance.now();
                const results = fuseHeadings.searchHeadings(query, 20);
                const duration = performance.now() - start;

                console.log(`[Perf] Fuse heading search "${query}": ${duration.toFixed(1)}ms (${results.length} results)`);
                expect(duration).toBeLessThan(200);
            }
        });

        it("Mini heading search (100k) should complete in <200ms", () => {
            const queries = ["introduction", "overview", "getting", "advanced"];

            for (const query of queries) {
                const start = performance.now();
                const results = miniHeadings.searchHeadings(query, 20);
                const duration = performance.now() - start;

                console.log(`[Perf] Mini heading search "${query}": ${duration.toFixed(1)}ms (${results.length} results)`);
                expect(duration).toBeLessThan(200);
            }
        });

        it("Search with various query lengths", () => {
            const queries = [
                "a",           // 1 char
                "test",        // 4 chars
                "introduction", // 12 chars
                "getting started with" // 20 chars
            ];

            for (const query of queries) {
                const startFuse = performance.now();
                const fusResults = fuseHeadings.searchHeadings(query, 20);
                const fuseDuration = performance.now() - startFuse;

                const startMini = performance.now();
                const miniResults = miniHeadings.searchHeadings(query, 20);
                const miniDuration = performance.now() - startMini;

                console.log(`[Perf] Search "${query}" (${query.length} chars): Fuse=${fuseDuration.toFixed(1)}ms Mini=${miniDuration.toFixed(1)}ms`);

                expect(fuseDuration).toBeLessThan(300);
                expect(miniDuration).toBeLessThan(300);
            }
        });
    });

    describe("Comparative Performance", () => {
        it("Compare Fuse vs Mini for heading search", async () => {
            const sizes = [10000, 50000, 100000];

            for (const size of sizes) {
                const headings = generateHeadings(size);

                // Fuse
                const fuseEngine = new FuseEngine();
                const fuseBuildStart = performance.now();
                fuseEngine.setHeadings(headings);
                const fuseBuildTime = performance.now() - fuseBuildStart;

                const fuseSearchStart = performance.now();
                const fuseResults = fuseEngine.searchHeadings("introduction", 20);
                const fuseSearchTime = performance.now() - fuseSearchStart;

                // Mini
                const miniEngine = new MiniSearchEngine();
                const miniBuildStart = performance.now();
                await miniEngine.setHeadingsAsync(headings);
                const miniBuildTime = performance.now() - miniBuildStart;

                const miniSearchStart = performance.now();
                const miniResults = miniEngine.searchHeadings("introduction", 20);
                const miniSearchTime = performance.now() - miniSearchStart;

                console.log(`\n[Perf] ${size.toLocaleString()} headings:`);
                console.log(`  Fuse: build=${fuseBuildTime.toFixed(1)}ms search=${fuseSearchTime.toFixed(1)}ms results=${fuseResults.length}`);
                console.log(`  Mini: build=${miniBuildTime.toFixed(1)}ms search=${miniSearchTime.toFixed(1)}ms results=${miniResults.length}`);
                console.log(`  Winner: ${miniSearchTime < fuseSearchTime ? 'Mini' : 'Fuse'} (${Math.abs(miniSearchTime - fuseSearchTime).toFixed(1)}ms faster)`);
            }
        });
    });
});
