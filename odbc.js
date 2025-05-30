module.exports = function (RED) {
    const odbcModule = require("odbc");
    const mustache = require("mustache"); // Utilisé dans runQuery
    const objPath = require("object-path"); // Utilisé pour mustache et le positionnement du résultat

    // --- ODBC Configuration Node ---
    function poolConfig(config) {
        RED.nodes.createNode(this, config);
        this.config = config;
        this.pool = null;
        this.connecting = false;
        
        this.credentials = RED.nodes.getCredentials(this.id);

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
                if (this.credentials && this.credentials.password && connStr.includes('{{{password}}}')) {
                    connStr = connStr.replace('{{{password}}}', this.credentials.password);
                }
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
        const tempConfig = req.body;
        const tempCredentials = { password: tempConfig.password };
        delete tempConfig.password;

        const buildTestConnectionString = () => {
             if (tempConfig.connectionMode === 'structured') {
                if (!tempConfig.dbType || !tempConfig.server) return res.status(400).send("Mode structuré : le type de BD et le serveur sont requis.");
                let driver;
                let parts = [];
                switch (tempConfig.dbType) {
                    case 'sqlserver': driver = 'ODBC Driver 17 for SQL Server'; break;
                    case 'postgresql': driver = 'PostgreSQL Unicode'; break;
                    case 'mysql': driver = 'MySQL ODBC 8.0 Unicode Driver'; break;
                    default: driver = tempConfig.driver || ''; break;
                }
                if(driver) parts.unshift(`DRIVER={${driver}}`);
                parts.push(`SERVER=${tempConfig.server}`);
                if (tempConfig.database) parts.push(`DATABASE=${tempConfig.database}`);
                if (tempConfig.user) parts.push(`UID=${tempConfig.user}`);
                if (tempCredentials.password) parts.push(`PWD=${tempCredentials.password}`);
                return parts.join(';');
            } else {
                let connStr = tempConfig.connectionString || "";
                if (tempCredentials.password && connStr.includes('{{{password}}}')) {
                    connStr = connStr.replace('{{{password}}}', tempCredentials.password);
                }
                return connStr;
            }
        };

        let connection;
        try {
            const testConnectionString = buildTestConnectionString();
            if (!testConnectionString) return res.status(400).send("La chaîne de connexion est vide.");
            connection = await odbcModule.connect(testConnectionString);
            res.sendStatus(200);
        } catch (err) {
            res.status(500).send(err.message || "Erreur inconnue durant le test.");
        } finally {
            if (connection) await connection.close();
        }
    });

    // --- ODBC Query Node ---
    function odbc(config) {
        RED.nodes.createNode(this, config);
        this.config = config;
        this.poolNode = RED.nodes.getNode(this.config.connection);
        this.name = this.config.name;
        this.isAwaitingRetry = false;
        this.retryTimer = null;

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

        this.executeQueryAndProcess = async (dbConnection, queryString, queryParams, isPreparedStatement, msg) => {
            let result;
            if (isPreparedStatement) {
                const stmt = await dbConnection.createStatement();
                try {
                    await stmt.prepare(queryString);
                    await stmt.bind(queryParams);
                    result = await stmt.execute();
                } finally {
                    if (stmt && typeof stmt.close === "function") {
                        try { await stmt.close(); } catch (stmtCloseError) { this.warn(`Error closing statement: ${stmtCloseError}`); }
                    }
                }
            } else {
                result = await dbConnection.query(queryString, queryParams);
            }
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
            if (this.poolNode?.parser && queryString) {
                try {
                    newMsg.parsedQuery = this.poolNode.parser.astify(structuredClone(queryString));
                } catch (syntaxError) {
                    this.warn(`Could not parse query for parsedQuery output: ${syntaxError}`);
                }
            }
            if (Object.keys(otherParams).length) { newMsg.odbc = otherParams; }
            return newMsg;
        };
        
        this.executeStreamQuery = async (dbConnection, queryString, queryParams, msg, send, done) => {
            const chunkSize = parseInt(this.config.streamChunkSize) || 1;
            let cursor;
            let rowCount = 0;
            let chunk = [];
            
            try {
                cursor = await dbConnection.cursor(queryString, queryParams);
                this.status({ fill: "blue", shape: "dot", text: "streaming rows..." });
                let row = await cursor.fetch();
                while (row) {
                    rowCount++;
                    chunk.push(row);
                    if (chunk.length >= chunkSize) {
                        const newMsg = RED.util.cloneMessage(msg);
                        objPath.set(newMsg, this.config.outputObj, chunk);
                        newMsg.odbc_stream = { index: rowCount - chunk.length, count: chunk.length, complete: false };
                        send(newMsg);
                        chunk = [];
                    }
                    row = await cursor.fetch();
                }
                if (chunk.length > 0) {
                    const newMsg = RED.util.cloneMessage(msg);
                    objPath.set(newMsg, this.config.outputObj, chunk);
                    newMsg.odbc_stream = { index: rowCount - chunk.length, count: chunk.length, complete: true };
                    send(newMsg);
                }
                if (rowCount === 0) {
                     const newMsg = RED.util.cloneMessage(msg);
                     objPath.set(newMsg, this.config.outputObj, []);
                     newMsg.odbc_stream = { index: 0, count: 0, complete: true };
                     send(newMsg);
                }
                this.status({ fill: "green", shape: "dot", text: `success (${rowCount} rows)` });
                if(done) done();
            } catch(err) {
                throw err;
            }
            finally {
                if (cursor) await cursor.close();
            }
        };

        this.runQuery = async (msg, send, done) => {
             let currentQueryString = this.config.query || "";
             let currentQueryParams = msg.parameters;
             let isPreparedStatement = false;
             let connectionFromPool = null;

             try {
                this.status({ fill: "blue", shape: "dot", text: "preparing..." });
                this.config.outputObj = msg?.output || this.config?.outputObj || "payload";

                isPreparedStatement = currentQueryParams || (currentQueryString && currentQueryString.includes("?"));
                if (!isPreparedStatement && currentQueryString) {
                    for (const parsed of mustache.parse(currentQueryString)) {
                        if ((parsed[0] === "name" || parsed[0] === "&") && !objPath.has(msg, parsed[1])) {
                            this.warn(`Mustache parameter "${parsed[1]}" is absent.`);
                        }
                    }
                    currentQueryString = mustache.render(currentQueryString, msg);
                }
                if (msg?.query) { currentQueryString = msg.query; }
                if (!currentQueryString) { throw new Error("No query to execute"); }

                const execute = async (conn) => {
                    if (this.config.streaming) {
                        await this.executeStreamQuery(conn, currentQueryString, currentQueryParams, msg, send, done);
                    } else {
                        const processedMsg = await this.executeQueryAndProcess(conn, currentQueryString, currentQueryParams, isPreparedStatement, msg);
                        this.status({ fill: "green", shape: "dot", text: "success" });
                        send(processedMsg);
                        if(done) done();
                    }
                };

                let firstAttemptError = null;
                try {
                    connectionFromPool = await this.poolNode.connect();
                    await execute(connectionFromPool);
                    return;
                } catch (err) {
                    firstAttemptError = this.enhanceError(err, currentQueryString, currentQueryParams, "Query failed with pooled connection");
                    this.warn(`First attempt failed: ${firstAttemptError.message}`);
                } finally {
                    if (connectionFromPool) await connectionFromPool.close();
                }

                if (firstAttemptError) {
                    if (this.poolNode && this.poolNode.config.retryFreshConnection) {
                        this.log("Attempting retry with a fresh connection.");
                        this.status({ fill: "yellow", shape: "dot", text: "Retrying (fresh)..." });
                        let freshConnection = null;
                        try {
                            const freshConnectConfig = this.poolNode.getFreshConnectionConfig();
                            freshConnection = await odbcModule.connect(freshConnectConfig);
                            this.log("Fresh connection established for retry.");
                            await execute(freshConnection);
                            this.log("Query successful with fresh connection. Resetting pool.");
                            await this.poolNode.resetPool();
                            return;
                        } catch (freshError) {
                            this.warn(`Retry with fresh connection also failed: ${freshError.message}`);
                            const retryDelay = parseInt(this.poolNode.config.retryDelay) || 0;
                            if (retryDelay > 0) {
                                this.isAwaitingRetry = true;
                                this.status({ fill: "red", shape: "ring", text: `Retry in ${retryDelay}s...` });
                                this.log(`Scheduling retry in ${retryDelay} seconds.`);
                                this.retryTimer = setTimeout(() => {
                                    this.isAwaitingRetry = false;
                                    this.log("Timer expired. Triggering scheduled retry.");
                                    this.receive(msg);
                                }, retryDelay * 1000);
                                if (done) done();
                            } else {
                                throw this.enhanceError(freshError, currentQueryString, currentQueryParams, "Query failed on fresh connection retry");
                            }
                        } finally {
                            if (freshConnection) await freshConnection.close();
                        }
                    } else {
                        throw firstAttemptError;
                    }
                }
             } catch (err) {
                 const finalError = err instanceof Error ? err : new Error(String(err));
                 this.status({ fill: "red", shape: "ring", text: "query error" });
                 if (done) { done(finalError); } else { this.error(finalError, msg); }
             }
        };

        this.checkPool = async function (msg, send, done) {
            try {
                if (!this.poolNode) { throw new Error("ODBC Config node not properly configured."); }
                if (this.poolNode.connecting) {
                    this.warn("Waiting for connection pool to initialize...");
                    this.status({ fill: "yellow", shape: "ring", text: "Waiting for pool" });
                    setTimeout(() => {
                        this.checkPool(msg, send, done).catch((err) => {
                            this.status({ fill: "red", shape: "dot", text: "Pool wait failed" });
                            if (done) { done(err); } else { this.error(err, msg); }
                        });
                    }, 1000);
                    return;
                }
                await this.runQuery(msg, send, done);
            } catch (err) {
                const finalError = err instanceof Error ? err : new Error(String(err));
                this.status({ fill: "red", shape: "dot", text: "Op failed" });
                if (done) { done(finalError); } else { this.error(finalError, msg); }
            }
        };

        this.on("input", async (msg, send, done) => {
            if (this.isAwaitingRetry) {
                if (this.poolNode && this.poolNode.config.retryOnMsg) {
                    this.log("New message received, overriding retry timer and attempting query now.");
                    clearTimeout(this.retryTimer);
this.retryTimer = null;
                    this.isAwaitingRetry = false;
                } else {
                    this.warn("Node is in a retry-wait state. New message ignored as per configuration.");
                    if (done) done();
                    return;
                }
            }
            try {
                await this.checkPool(msg, send, done);
            } catch (error) {
                const finalError = error instanceof Error ? error : new Error(String(error));
                this.status({ fill: "red", shape: "ring", text: "Input error" });
                if (done) { done(finalError); } else { this.error(finalError, msg); }
            }
        });

        this.on("close", async (done) => {
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.log("Cleared pending retry timer on node close/redeploy.");
            }
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