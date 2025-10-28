declare module "better-sqlite3" {
    interface RunResult {
        changes: number;
        lastInsertRowid: number | bigint;
    }

    interface Statement<T = unknown> {
        run(...params: unknown[]): RunResult;
        get(...params: unknown[]): T;
        all(...params: unknown[]): T[];
        pluck(toggle?: boolean): Statement<T>;
    }

    interface Database {
        prepare<T = unknown>(sql: string): Statement<T>;
        exec(sql: string): Database;
        pragma(query: string): unknown;
        transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
        close(): void;
    }

    interface DatabaseConstructor {
        new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): Database;
    }

    const Database: DatabaseConstructor;
    export { RunResult, Statement, Database, DatabaseConstructor };
    export default Database;
}
