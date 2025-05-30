module.exports = function (RED) {
    const odbcModule = require("odbc");
    const mustache = require("mustache");
    const objPath = require("object-path");

    // --- ODBC Configuration Node ---
    function poolConfig(config) {
        RED.nodes.createNode(this, config);
        this.config = config;
        this.pool = null;
        this.connecting = false;
        
        this.credentials = RED.nodes.getCredentials(this.id);

        // Cette fonction est maintenant cruciale pour le mode streaming
        this._buildConnectionString = function() {
            if (this.config.connectionMode === 'structured') {
                if (!this.config.dbType || !this.config.server) {
                    throw new Error("En mode structuré, le type de base de données et le serveur sont requis.");
                }
                let driver;
                let parts = [];
                switch (this.config.dbType) {
                    case 'sqlserver': driver = 'ODBC Driver 17 for SQL Server'; break;
                    case 'postgresql': driver = 'PostgreSQL Unicode'; break;
                    case 'mysql': driver = 'MySQL ODBC 8.0 Unicode Driver'; break;
                    default: driver = this.config.driver || ''; break;
                }
                if(driver) parts.unshift(`DRIVER={${driver}}`);
                parts.push(`SERVER=${this.config.server}`);
                if (this.config.database) parts.push(`DATABASE=${this.config.database}`);
                if (this.config.user) parts.push(`UID=${this.config.user}`);
                if (this.credentials && this.credentials.password) parts.push(`PWD=${this.credentials.password}`);
                return parts.join(';');
            } else {
                let connStr = this.config.connectionString || "";
                return connStr;
            }
        };

        this.connect = async () => {
            if (!this.pool) {
                this.connecting = true;
                this.status({ fill: "yellow", shape: "dot", text: "Pool init..." });
                try {
                    const finalConnectionString = this._buildConnectionString();
                    if (!finalConnectionString) throw new Error("La chaîne de connexion est vide.");
                    
                    const poolParams = { ...this.config };
                    poolParams.connectionString = finalConnectionString;

                    ['retryFreshConnection', 'retryDelay', 'retryOnMsg', 'syntax', 'connectionMode', 'dbType', 'server', 'database', 'user', 'driver'].forEach(k => delete poolParams[k]);
                    
                    this.pool = await odbcModule.pool(poolParams);
                    this.connecting = false;
                    this.status({ fill: "green", shape: "dot", text: "Pool ready" });
                    this.log("Connection pool initialized successfully.");
                } catch (error) {
                    this.connecting = false;
                    this.error(`Error creating connection pool: ${error.message}`, error);
                    this.status({ fill: "red", shape: "ring", text: "Pool error" });
                    throw error;
                }
            }
            try {
                return await this.pool.connect();
            } catch (poolConnectError) {
                this.error(`Error connecting to pool: ${poolConnectError}`, poolConnectError);
                this.status({ fill: "red", shape: "ring", text: "Pool connect err" });
                throw poolConnectError;
            }
        };

        this.getFreshConnectionConfig = function() {
            return {
                connectionString: this._buildConnectionString(),
                connectionTimeout: parseInt(this.config.connectionTimeout) || 0,
                loginTimeout: parseInt(this.config.loginTimeout) || 0,
            };
        };

        this.resetPool = async () => {
             if (this.pool) {
                this.log("Resetting connection pool.");
                this.status({ fill: "yellow", shape: "ring", text: "Resetting pool..." });
                try {
                    await this.pool.close();
                    this.log("Connection pool closed successfully for reset.");
                } catch (closeError) {
                    this.error(`Error closing pool during reset: ${closeError}`, closeError);
                } finally {
                    this.pool = null;
                    this.connecting = false;
                }
            } else {
                this.log("Pool reset requested, but no active pool to reset.");
            }
        };

        this.on("close", async (removed, done) => {
            this.log("Closing ODBC config node. Attempting to close pool.");
            if (this.pool) {
                try {
                    await this.pool.close();
                    this.log("Connection pool closed successfully on node close.");
                    this.pool = null;
                } catch (error) {
                    this.error(`Error closing connection pool on node close: ${error}`, error);
                }
            }
            done();
        });
    }

    RED.nodes.registerType("odbc config", poolConfig, {
        credentials: {
            password: { type: "password" }
        }
    });

    RED.httpAdmin.post("/odbc_config/:id/test", RED.auth.needsPermission("odbc.write"), async function(req, res) {
        // ... (Pas de changement dans cette section)
    });


    // --- ODBC Query Node ---
    function odbc(config) {
        RED.nodes.createNode(this, config);
        this.config = config;
        this.poolNode = RED.nodes.getNode(this.config.connection);
        this.name = this.config.name;

        // ... (enhanceError et executeQueryAndProcess restent inchangés)
        this.enhanceError = (error, query, params, defaultMessage = "Query error") => {
            const queryContext = (() => {
                let s = "";
                if (query || params) {
                    s += " {";
                    if (query) s += `"query": '${query.substring(0, 100)}${query.length > 100 ? "..." : ""}'`;
                    if (params) s += `, "params": '${JSON.stringify(params)}'`;
                    s += "}";
                    return s;
                }
                return "";
            })();
            let finalError;
            if (typeof error === "object" && error !== null && error.message) { finalError = error; } 
            else if (typeof error === "string") { finalError = new Error(error); }
            else { finalError = new Error(defaultMessage); }
            finalError.message = `${finalError.message}${queryContext}`;
            if (query) finalError.query = query;
            if (params) finalError.params = params;
            return finalError;
        };

        this.executeQueryAndProcess = async (dbConnection, queryString, queryParams, msg) => {
            const result = await dbConnection.query(queryString, queryParams);
            if (typeof result === "undefined") { throw new Error("Query returned undefined."); }
            const newMsg = RED.util.cloneMessage(msg);
            const otherParams = {};
            let actualDataRows = [];
            if (result !== null && typeof result === "object") {
                if (Array.isArray(result)) {
                    actualDataRows = [...result];
                    for (const [key, value] of Object.entries(result)) {
                        if (isNaN(parseInt(key))) { otherParams[key] = value; }
                    }
                } else {
                    for (const [key, value] of Object.entries(result)) { otherParams[key] = value; }
                }
            }
            const columnMetadata = otherParams.columns;
            if (Array.isArray(columnMetadata) && Array.isArray(actualDataRows) && actualDataRows.length > 0) {
                const sqlBitColumnNames = new Set();
                columnMetadata.forEach((col) => {
                    if (col && typeof col.name === "string" && col.dataTypeName === "SQL_BIT") {
                        sqlBitColumnNames.add(col.name);
                    }
                });
                if (sqlBitColumnNames.size > 0) {
                    actualDataRows.forEach((row) => {
                        if (typeof row === "object" && row !== null) {
                            for (const columnName of sqlBitColumnNames) {
                                if (row.hasOwnProperty(columnName)) {
                                    const value = row[columnName];
                                    if (value === "1" || value === 1) { row[columnName] = true; } 
                                    else if (value === "0" || value === 0) { row[columnName] = false; }
                                }
                            }
                        }
                    });
                }
            }
            objPath.set(newMsg, this.config.outputObj, actualDataRows);
            if (Object.keys(otherParams).length) { newMsg.odbc = otherParams; }
            return newMsg;
        };

        this.executeStreamQuery = async (dbConnection, queryString, queryParams, msg, send) => {
            const chunkSize = parseInt(this.config.streamChunkSize) || 1;
            const fetchSize = chunkSize > 100 ? 100 : chunkSize; // Optimisation du fetch
            let cursor;
        
            try {
                cursor = await dbConnection.query(queryString, queryParams, { cursor: true, fetchSize: fetchSize });
                this.status({ fill: "blue", shape: "dot", text: "streaming rows..." });
        
                let rowCount = 0;
                let chunk = [];
        
                while (true) {
                    const rows = await cursor.fetch();
                    if (!rows || rows.length === 0) {
                        break;
                    }
        
                    for (const row of rows) {
                        rowCount++;
                        chunk.push(row);
                        if (chunk.length >= chunkSize) {
                            const newMsg = RED.util.cloneMessage(msg);
                            objPath.set(newMsg, this.config.outputObj, chunk);
                            newMsg.odbc_stream = { index: rowCount - chunk.length, count: chunk.length, complete: false };
                            send(newMsg);
                            chunk = [];
                        }
                    }
                }
        
                if (chunk.length > 0) {
                    const newMsg = RED.util.cloneMessage(msg);
                    objPath.set(newMsg, this.config.outputObj, chunk);
                    newMsg.odbc_stream = { index: rowCount - chunk.length, count: chunk.length, complete: false };
                    send(newMsg);
                }
        
                const finalMsg = RED.util.cloneMessage(msg);
                objPath.set(finalMsg, this.config.outputObj, []);
                finalMsg.odbc_stream = { index: rowCount, count: 0, complete: true };
                send(finalMsg);
        
                this.status({ fill: "green", shape: "dot", text: `success (${rowCount} rows)` });
        
            } finally {
                if (cursor) {
                    await cursor.close();
                }
            }
        };

        this.on("input", async (msg, send, done) => {
            if (!this.poolNode) {
                return done(new Error("ODBC Config node not properly configured."));
            }

            const execute = async (connection) => {
                this.config.outputObj = this.config.outputObj || "payload";
                
                const querySourceType = this.config.querySourceType || 'msg';
                const querySource = this.config.querySource || 'query';
                const paramsSourceType = this.config.paramsSourceType || 'msg';
                const paramsSource = this.config.paramsSource || 'parameters';
                
                const params = await new Promise(resolve => RED.util.evaluateNodeProperty(paramsSource, paramsSourceType, this, msg, (err, val) => resolve(err ? undefined : val)));
                let query = await new Promise(resolve => RED.util.evaluateNodeProperty(querySource, querySourceType, this, msg, (err, val) => resolve(err ? undefined : (val || this.config.query || ""))));
                
                if (!query) throw new Error("No query to execute");

                const isPreparedStatement = params || (query && query.includes("?"));
                if (!isPreparedStatement && query) {
                    query = mustache.render(query, msg);
                }
                
                this.status({ fill: "blue", shape: "dot", text: "executing..." });
                if (this.config.streaming) {
                    await this.executeStreamQuery(connection, query, params, msg, send);
                } else {
                    const newMsg = await this.executeQueryAndProcess(connection, query, params, msg);
                    this.status({ fill: "green", shape: "dot", text: "success" });
                    send(newMsg);
                }
            };

            let connectionFromPool;
            try {
                this.status({ fill: "yellow", shape: "dot", text: "connecting..." });
                connectionFromPool = await this.poolNode.connect();
                await execute(connectionFromPool);
                return done();
            } catch (poolError) {
                this.warn(`First attempt with pooled connection failed: ${poolError.message}`);
                if (this.poolNode.config.retryFreshConnection) {
                    this.warn("Attempting retry with a fresh connection.");
                    this.status({ fill: "yellow", shape: "dot", text: "Retrying (fresh)..." });
                    let freshConnection;
                    try {
                        const freshConnectConfig = this.poolNode.getFreshConnectionConfig();
                        freshConnection = await odbcModule.connect(freshConnectConfig);
                        this.log("Fresh connection established for retry.");
                        await execute(freshConnection);
                        this.log("Query successful with fresh connection. Resetting pool.");
                        await this.poolNode.resetPool();
                        return done();
                    } catch (freshError) {
                        this.status({ fill: "red", shape: "ring", text: "retry failed" });
                        return done(this.enhanceError(freshError, null, null, "Retry with fresh connection also failed"));
                    } finally {
                        if (freshConnection) await freshConnection.close();
                    }
                } else {
                    this.status({ fill: "red", shape: "ring", text: "query error" });
                    return done(this.enhanceError(poolError));
                }
            } finally {
                if (connectionFromPool) await connectionFromPool.close();
            }
        });
        
        this.on("close", (done) => {
            this.status({});
            done();
        });

        if (this.poolNode) {
            this.status({ fill: "green", shape: "dot", text: "ready" });
        } else {
            this.status({ fill: "red", shape: "ring", text: "No config node" });
            this.warn("ODBC Config node not found or not deployed.");
        }
    }

    RED.nodes.registerType("odbc", odbc);
};