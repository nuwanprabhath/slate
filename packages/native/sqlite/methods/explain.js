import { cppdb } from '../util.js';

export default function explain(source) {
	if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string');

	const stmt = this[cppdb].prepare(`EXPLAIN ${source}`, this, false, true);
	return stmt.all();
};
