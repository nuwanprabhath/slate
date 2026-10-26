import fs from 'node:fs';
import path from 'node:path';
import * as util from './util.js';
import SqliteError from './sqlite-error.js';
import * as wrappers from './methods/wrappers.js';
import transaction from './methods/transaction.js';
import pragma from './methods/pragma.js';
import explain from './methods/explain.js';
import inspect from './methods/inspect.js';

export { SqliteError };

export default function createDatabase(getAddon, allowNativeBinding) {
	function Database(filenameGiven, options) {
		if (new.target == null) {
			return new Database(filenameGiven, options);
		}

		// Apply defaults
		let buffer;
		if (Buffer.isBuffer(filenameGiven)) {
			buffer = filenameGiven;
			filenameGiven = ':memory:';
		}
		if (filenameGiven == null) filenameGiven = '';
		if (options == null) options = {};

		// Validate arguments
		if (typeof filenameGiven !== 'string') throw new TypeError('Expected first argument to be a string');
		if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object');
		if ('readOnly' in options) throw new TypeError('Misspelled option "readOnly" should be "readonly"');
		if ('memory' in options) throw new TypeError('Option "memory" was removed in v7.0.0 (use ":memory:" filename instead)');

		// Interpret options
		const filename = filenameGiven.trim();
		const anonymous = filename === '' || filename === ':memory:';
		const readonly = util.getBooleanOption(options, 'readonly');
		const fileMustExist = util.getBooleanOption(options, 'fileMustExist');
		const timeout = 'timeout' in options ? options.timeout : 5000;
		const verbose = 'verbose' in options ? options.verbose : null;
		const nativeBinding = 'nativeBinding' in options ? options.nativeBinding : null;

		// Validate interpreted options
		if (readonly && anonymous && !buffer) throw new TypeError('In-memory/temporary databases cannot be readonly');
		if (!Number.isInteger(timeout) || timeout < 0) throw new TypeError('Expected the "timeout" option to be a positive integer');
		if (timeout > 0x7fffffff) throw new RangeError('Option "timeout" cannot be greater than 2147483647');
		if (verbose != null && typeof verbose !== 'function') throw new TypeError('Expected the "verbose" option to be a function');
		if (!allowNativeBinding && 'nativeBinding' in options) throw new TypeError('The "nativeBinding" option is only supported by the default better-sqlite3 entrypoint');
		if (allowNativeBinding && nativeBinding != null && typeof nativeBinding !== 'string' && typeof nativeBinding !== 'object') throw new TypeError('Expected the "nativeBinding" option to be a string or addon object');

		// Load the native addon
		const addon = getAddon(nativeBinding);
		if (!addon.isInitialized) {
			addon.initialize(SqliteError, arrayFactory, arrayAppender, rowFactory, recordFactory);
			addon.isInitialized = true;
		}

		// Make sure the specified directory exists
		if (!anonymous && !filename.startsWith('file:') && !fs.existsSync(path.dirname(filename))) {
			throw new TypeError('Cannot open database because the directory does not exist');
		}

		Object.defineProperties(this, {
			[util.cppdb]: { value: new addon.Database(filename, filenameGiven, anonymous, readonly, fileMustExist, timeout, verbose || null, buffer || null) },
			...wrappers.getters,
		});
	}

	Database.prototype.prepare = wrappers.prepare;
	Database.prototype.keyWithHandle = wrappers.keyWithHandle;
	Database.prototype.rekeyWithHandle = wrappers.rekeyWithHandle;
	Database.prototype.importPlaintextDatabase = wrappers.importPlaintextDatabase;
	Database.prototype.transaction = transaction;
	Database.prototype.pragma = pragma;
	Database.prototype.explain = explain;
	Database.prototype.exec = wrappers.exec;
	Database.prototype.close = wrappers.close;
	Database.prototype.defaultSafeIntegers = wrappers.defaultSafeIntegers;
	Database.prototype[util.inspect] = inspect;

	return Database;
}

function arrayFactory(...values) {
	return values;
}

function arrayAppender(array, ...values) {
	const offset = array.length;
	for (let i = 0; i < values.length; ++i) {
		array[offset + i] = values[i];
	}
}

function rowFactory(...keys) {
	if (!keys.includes('__proto__')) {
		const parameters = keys.map((_, index) => `v${index}`).join(',');
		const properties = keys.map((key, index) => `${JSON.stringify(key)}:v${index}`).join(',');
		return Function(`return (${parameters}) => ({${properties}})`)();
	}
	return (...values) => {
		const row = {};
		for (let i = 0; i < keys.length; ++i) row[keys[i]] = values[i];
		return row;
	};
}

function recordFactory(value) {
	return { value, done: false };
}
