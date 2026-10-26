import { cppdb } from '../util.js';

export const prepare = function prepare(sql) {
	return this[cppdb].prepare(sql, this, false, false);
};

// Slate: a key enters SQLCipher only as a @slate/native key handle, never as JS bytes (audit C3).
export const keyWithHandle = function keyWithHandle(handle) {
	return this[cppdb].keyWithHandle(handle);
};

export const rekeyWithHandle = function rekeyWithHandle(handle) {
	return this[cppdb].rekeyWithHandle(handle);
};

// Slate: the migration's plaintext-to-encrypted copy; ATTACH and sqlcipher_export are refused in SQL text.
export const importPlaintextDatabase = function importPlaintextDatabase(file) {
	return this[cppdb].importPlaintextDatabase(file);
};

export const exec = function exec(sql) {
	this[cppdb].exec(sql);
	return this;
};

export const close = function close() {
	this[cppdb].close();
	return this;
};

export const defaultSafeIntegers = function defaultSafeIntegers(...args) {
	this[cppdb].defaultSafeIntegers(...args);
	return this;
};

export const getters = {
	name: {
		get: function name() { return this[cppdb].name; },
		enumerable: true,
	},
	open: {
		get: function open() { return this[cppdb].open; },
		enumerable: true,
	},
	inTransaction: {
		get: function inTransaction() { return this[cppdb].inTransaction; },
		enumerable: true,
	},
	readonly: {
		get: function readonly() { return this[cppdb].readonly; },
		enumerable: true,
	},
	memory: {
		get: function memory() { return this[cppdb].memory; },
		enumerable: true,
	},
};
