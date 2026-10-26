class Database : public Napi::ObjectWrap<Database> {
public:

	explicit Database(const Napi::CallbackInfo& info);
	~Database();

	// Whenever this is used, addon->dbs.erase() must be invoked beforehand.
	void CloseHandles();

	// Slate (re-review R-M1, review C3 FC-L1): the module's error state poisons every connection at once and
	// closes it unless a statement is running right now (busy), which is the invariant the rest of the binding
	// relies on. A paused iterator does not defer the close: it finds the connection closed and only ends.
	// Every entry point refuses a poisoned connection; FinishPoison closes it at the next idle point (the end
	// of a statement, or at once if no statement is running).
	void Poison();
	void FinishPoison();

	// Used to support ordered containers.
	class CompareDatabase { public:
		inline bool operator() (Database const * const a, Database const * const b) const {
			return a < b;
		}
	};
	class CompareStatement { public:
		inline bool operator() (Statement const * const a, Statement const * const b) const {
			return Statement::Compare(a, b);
		}
	};
	class CompareBackup { public:
		inline bool operator() (Backup const * const a, Backup const * const b) const {
			return Backup::Compare(a, b);
		}
	};

	// Proper error handling logic for when an sqlite3 operation fails.
	void ThrowDatabaseError(Napi::Env env);
	static void ThrowSqliteError(Napi::Env env, Addon* addon, sqlite3* db_handle);
	static void ThrowSqliteError(Napi::Env env, Addon* addon, const char* message, int code);

	// Allows Statements to log their executed SQL.
	bool Log(Napi::Env env, sqlite3_stmt* handle);

	// Allow Statements to manage themselves when created and garbage collected.
	inline void AddStatement(Statement* stmt) { stmts.insert(stmts.end(), stmt); }
	inline void RemoveStatement(Statement* stmt) { stmts.erase(stmt); }

	// Allow Backups to manage themselves when created and garbage collected.
	inline void AddBackup(Backup* backup) { backups.insert(backups.end(), backup); }
	inline void RemoveBackup(Backup* backup) { backups.erase(backup); }

	// A view for Statements to see and modify Database state.
	// The order of these fields must exactly match their actual order.
	struct State {
		const bool open;
		bool busy;
		const bool safe_ints;
		const bool unsafe_mode;
		bool was_js_error;
		const bool has_logger;
		const bool poisoned;
		unsigned short iterators;
		Addon* const addon;
	};

	inline State* GetState() { return reinterpret_cast<State*>(&open); }
	inline sqlite3* GetHandle() { return db_handle; }
	inline Addon* GetAddon() { return addon; }

	// Identifies objects that are backed by this class (see IsInstanceOf).
	static const napi_type_tag TYPE_TAG;

	static INIT(Init);

private:

	NODE_METHOD(JS_new);
	static NODE_METHOD(JS_prepare);
	static NODE_METHOD(JS_keyWithHandle);
	static NODE_METHOD(JS_rekeyWithHandle);
	static Napi::Value KeyWithHandle(const Napi::CallbackInfo& info, int rekey);
	static NODE_METHOD(JS_importPlaintextDatabase);
	static NODE_METHOD(JS_exec);
	static NODE_METHOD(JS_backup);
	static NODE_METHOD(JS_serialize);
	static NODE_METHOD(JS_function);
	static NODE_METHOD(JS_aggregate);
	static NODE_METHOD(JS_table);
	static NODE_METHOD(JS_close);
	static NODE_METHOD(JS_defaultSafeIntegers);
	static NODE_METHOD(JS_unsafeMode);
	static NODE_GETTER(JS_open);
	static NODE_GETTER(JS_inTransaction);

	static bool Deserialize(Napi::Env env, Napi::Object buffer, Addon* addon, sqlite3* db_handle, bool readonly);
	static void FreeSerialization(Napi::Env env, char* data);

	static const int MAX_BUFFER_SIZE;
	static const int MAX_STRING_SIZE;

	sqlite3* db_handle;
	bool open;
	bool busy;
	bool safe_ints;
	bool unsafe_mode;
	bool was_js_error;
	bool has_logger;
	bool poisoned;
	unsigned short iterators;
	Addon* const addon;
	Napi::Reference<Napi::Value> logger;
	std::set<Statement*, CompareStatement> stmts;
	std::set<Backup*, CompareBackup> backups;
	slate_conn slate;
};
