// Type definitions for better-sqlite3-multiple-ciphers 11.8.0, as vendored by Slate (audit C3): keys only
// from a @slate/native key handle (keyWithHandle/rekeyWithHandle), no loadExtension, no nativeBinding.
// Project: https://github.com/m4heshd/better-sqlite3-multiple-ciphers
// Definitions by: Ben Davies <https://github.com/Morfent>
//                 Mathew Rumsey <https://github.com/matrumz>
//                 Santiago Aguilar <https://github.com/sant123>
//                 Alessandro Vergani <https://github.com/loghorn>
//                 Andrew Kaiser <https://github.com/andykais>
//                 Mark Stewart <https://github.com/mrkstwrt>
//                 Florian Stamer <https://github.com/stamerf>
//                 Mahesh Bandara Wijerathna <https://github.com/m4heshd>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped
// TypeScript Version: 3.8

/// <reference types="node" />
import type { KeyHandle } from '../index'

// `never[]` accepts every function type here, as upstream's `any[]` did.
type VariableArgFunction = (...params: never[]) => unknown;
type ArgumentTypes<F extends VariableArgFunction> = F extends (...args: infer A) => unknown ? A : never;
type ElementOf<T> = T extends Array<infer E> ? E : T;

declare namespace BetterSqlite3MultipleCiphers {
    interface Statement<BindParameters extends unknown[], Result = unknown> {
        database: Database;
        source: string;
        reader: boolean;
        readonly: boolean;
        busy: boolean;

        run(...params: BindParameters): Database.RunResult;
        get(...params: BindParameters): Result | undefined;
        all(...params: BindParameters): Result[];
        iterate(...params: BindParameters): IterableIterator<Result>;
        pluck(toggleState?: boolean): this;
        expand(toggleState?: boolean): this;
        raw(toggleState?: boolean): this;
        bind(...params: BindParameters): this;
        columns(): ColumnDefinition[];
        safeIntegers(toggleState?: boolean): this;
    }

    interface ColumnDefinition {
        name: string;
        column: string | null;
        table: string | null;
        database: string | null;
        type: string | null;
    }

    interface Transaction<F extends VariableArgFunction> {
        (...params: ArgumentTypes<F>): ReturnType<F>;
        default(...params: ArgumentTypes<F>): ReturnType<F>;
        deferred(...params: ArgumentTypes<F>): ReturnType<F>;
        immediate(...params: ArgumentTypes<F>): ReturnType<F>;
        exclusive(...params: ArgumentTypes<F>): ReturnType<F>;
    }

    interface VirtualTableOptions {
        rows: (...params: unknown[]) => Generator;
        columns: string[];
        parameters?: string[] | undefined;
        safeIntegers?: boolean | undefined;
        directOnly?: boolean | undefined;
    }

    interface Database {
        memory: boolean;
        readonly: boolean;
        name: string;
        open: boolean;
        inTransaction: boolean;

        prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
            source: string,
        ): BindParameters extends unknown[] ? Statement<BindParameters, Result> : Statement<[BindParameters], Result>;
        transaction<F extends VariableArgFunction>(fn: F): Transaction<F>;
        exec(source: string): this;
        /** Keys this connection from a native key handle (SQLCipher raw key). Throws `SCC_8` for a destroyed handle. */
        keyWithHandle(handle: KeyHandle): number;
        rekeyWithHandle(handle: KeyHandle): number;
        /** Copies a plaintext database file into this keyed, empty database (SQLCipher export, done natively). */
        importPlaintextDatabase(file: string): number;
        pragma(source: string, options?: Database.PragmaOptions): unknown;
        explain(source: string): unknown[];
        close(): this;
        defaultSafeIntegers(toggleState?: boolean): this;
    }

    interface DatabaseConstructor {
        new(filename?: string | Buffer, options?: Database.Options): Database;
        (filename?: string, options?: Database.Options): Database;
        prototype: Database;
        SqliteError: SqliteErrorType;
    }
}

declare class SqliteErrorClass extends Error {
    name: string;
    message: string;
    code: string;
    constructor(message: string, code: string);
}

type SqliteErrorType = typeof SqliteErrorClass;

export declare namespace Database {
    interface RunResult {
        changes: number;
        lastInsertRowid: number | bigint;
    }

    interface Options {
        readonly?: boolean | undefined;
        fileMustExist?: boolean | undefined;
        timeout?: number | undefined;
        verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | undefined;
    }

    interface SerializeOptions {
        attached?: string;
    }

    interface PragmaOptions {
        simple?: boolean | undefined;
    }

    interface RegistrationOptions {
        varargs?: boolean | undefined;
        deterministic?: boolean | undefined;
        safeIntegers?: boolean | undefined;
        directOnly?: boolean | undefined;
    }


    interface BackupMetadata {
        totalPages: number;
        remainingPages: number;
    }
    interface BackupOptions {
        progress: (info: BackupMetadata) => number;
    }

    type SqliteError = SqliteErrorType;
    type Statement<BindParameters extends unknown[] | {} = unknown[], Result = unknown> = BindParameters extends unknown[] ?
        BetterSqlite3MultipleCiphers.Statement<BindParameters, Result> :
        BetterSqlite3MultipleCiphers.Statement<[BindParameters], Result>;
    type Transaction<T extends VariableArgFunction = VariableArgFunction> = BetterSqlite3MultipleCiphers.Transaction<T>;
    type Database = BetterSqlite3MultipleCiphers.Database;
}

export type DatabaseConstructor = BetterSqlite3MultipleCiphers.DatabaseConstructor;
export declare const SqliteError: SqliteErrorType;
/** `getAddon` returns slate_native.node's `sqlite` export; `allowNativeBinding` is always false here. */
export default function createDatabase(getAddon: () => object, allowNativeBinding: false): DatabaseConstructor;
