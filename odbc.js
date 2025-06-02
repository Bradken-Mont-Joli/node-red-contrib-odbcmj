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

        this.config.queryTimeoutSeconds = parseInt(config.queryTimeoutSeconds, 10);
        if (isNaN(this.config.queryTimeoutSeconds) || this.config.queryTimeoutSeconds < 0) {
            this.config.queryTimeoutSeconds = 0; 
        }
        this.closeOperationTimeout = 10000; // 10 secondes

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
                return this.config.connectionString || "";
            }
        };

        this.connect = async () => {
            if (!this.pool) {
                this.connecting = true;
                this.status({ fill: "yellow", shape: "dot", text: "Pool init..." });
                try {
                    const finalConnectionString = this._buildConnectionString();
                    if (!finalConnectionString) throw new Error("La chaîne de connexion est vide.");
                    const poolParams = {
                        connectionString: finalConnectionString,
                        initialSize: parseInt(this.config.initialSize, 10) || undefined,
                        incrementSize: parseInt(this.config.incrementSize, 10) || undefined,
                        maxSize: parseInt(this.config.maxSize, 10) || undefined,
                        shrink: typeof this.config.shrink === 'boolean' ? this.config.shrink : true,
                        connectionTimeout: (parseInt(this.config.connectionTimeout, 10) * 1000) || undefined,
                        loginTimeout: parseInt(this.config.loginTimeout, 10) || undefined
                    };
                    Object.keys(poolParams).forEach(key => poolParams[key] === undefined && delete poolParams[key]);
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
                this.error(`Error connecting to pool: ${poolConnectError.message}`, poolConnectError);
                this.status({ fill: "red", shape: "ring", text: "Pool connect err" });
                throw poolConnectError;
            }
        };

        this.getFreshConnectionConfig = function() {
            return {
                connectionString: this._buildConnectionString(),
                connectionTimeout: 0, 
                loginTimeout: parseInt(this.config.loginTimeout, 10) || 5,
            };
        };

        this.resetPool = async () => {
            if (this.pool) {
                this.log("Resetting connection pool.");
                this.status({ fill: "yellow", shape: "ring", text: "Resetting pool..." });
                let closedSuccessfully = false;
                try {
                    await Promise.race([
                        this.pool.close(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Pool close timeout')), this.closeOperationTimeout))
                    ]);
                    this.log("Connection pool closed successfully for reset.");
                    closedSuccessfully = true;
                } catch (closeError) {
                    this.error(`Error or timeout closing pool during reset: ${closeError.message}`, closeError);
                } finally {
                    this.pool = null;
                    this.connecting = false;
                    this.status({ fill: closedSuccessfully ? "grey" : "red", shape: "ring", text: closedSuccessfully ? "Pool reset" : "Pool reset failed" });
                }
            } else {
                this.log("Pool reset requested, but no active pool to reset.");
            }
        };

        this.on("close", async (removed, done) => {
            this.log("Closing ODBC config node. Attempting to close pool.");
            if (this.pool) {
                try {
                    await Promise.race([
                        this.pool.close(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Pool close timeout on node close')), this.closeOperationTimeout))
                    ]);
                    this.log("Connection pool closed successfully on node close.");
                } catch (error) {
                    this.error(`Error or timeout closing connection pool on node close: ${error.message}`, error);
                } finally {
                    this.pool = null; 
                }
            }
            done();
        });
    }
    RED.nodes.registerType("odbc config", poolConfig, { credentials: { password: { type: "password" } } });

    RED.httpAdmin.post("/odbc_config/:id/test", RED.auth.needsPermission("odbc.write"), async function(req, res) {
        const tempConfig = req.body;
        const buildTestConnectionString = () => {
            if (tempConfig.connectionMode === 'structured') {
                if (!tempConfig.dbType || !tempConfig.server) { throw new Error("En mode structuré, le type de base de données et le serveur sont requis."); }
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
                if (tempConfig.password) parts.push(`PWD=${tempConfig.password}`);
                return parts.join(';');
            } else {
                let connStr = tempConfig.connectionString || "";
                if (!connStr) { throw new Error("La chaîne de connexion ne peut pas être vide."); }
                return connStr;
            }
        };
        let connection;
        try {
            const testConnectionString = buildTestConnectionString();
            const connectionOptions = { connectionString: testConnectionString, loginTimeout: 10 };
            connection = await odbcModule.connect(connectionOptions);
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
        this.cursorCloseOperationTimeout = 5000;
        this.currentQueryForErrorContext = null; 
        this.currentParamsForErrorContext = null;

        this.enhanceError = (error, query, params, defaultMessage = "Query error") => {
            const q = query || this.currentQueryForErrorContext;
            const p = params || this.currentParamsForErrorContext;
            const queryContext = (() => {
                let s = "";
                if (q || p) {
                    s += " {";
                    if (q) s += `"query": '${String(q).substring(0, 100)}${String(q).length > 100 ? "..." : ""}'`;
                    if (p) s += `, "params": '${JSON.stringify(p)}'`;
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
            if (q) finalError.query = String(q).substring(0,200);
            if (p) finalError.params = p;
            return finalError;
        };

        this.executeQueryAndProcess = async (dbConnection, queryString, queryParams, msg) => {
            const result = await dbConnection.query(queryString, queryParams);
            if (typeof result === "undefined") { throw new Error("Query returned undefined."); }
            const newMsg = RED.util.cloneMessage(msg);
            const outputProperty = this.config.outputObj || "payload";
            const otherParams = {};
            let actualDataRows = [];
            if (result !== null && typeof result === "object") {
                if (Array.isArray(result)) {
                    actualDataRows = result.map(row => (typeof row === 'object' && row !== null) ? { ...row } : row);
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
                columnMetadata.forEach(col => { if (col && typeof col.name === "string" && col.dataTypeName === "SQL_BIT") sqlBitColumnNames.add(col.name); });
                if (sqlBitColumnNames.size > 0) {
                    actualDataRows.forEach(row => {
                        if (typeof row === "object" && row !== null) {
                            for (const columnName of sqlBitColumnNames) {
                                if (row.hasOwnProperty(columnName)) {
                                    const value = row[columnName];
                                    if (value === "1" || value === 1) row[columnName] = true;
                                    else if (value === "0" || value === 0) row[columnName] = false;
                                }
                            }
                        }
                    });
                }
            }
            objPath.set(newMsg, outputProperty, actualDataRows);
            if (Object.keys(otherParams).length) newMsg.odbc = otherParams;
            return newMsg;
        };
        
        this.executeStreamQuery = async (dbConnection, queryString, queryParams, msg, send) => {
            const chunkSize = parseInt(this.config.streamChunkSize) || 1;
            const fetchSize = chunkSize > 100 ? 100 : chunkSize; 
            let cursor;
            try {
                cursor = await dbConnection.query(queryString, queryParams, { cursor: true, fetchSize: fetchSize });
                this.status({ fill: "blue", shape: "dot", text: "streaming rows..." });
                let rowCount = 0;
                let chunk = [];
                while (true) {
                    const rows = await cursor.fetch(); 
                    if (!rows || rows.length === 0) break;
                    for (const row of rows) {
                        rowCount++;
                        const cleanRow = (typeof row === 'object' && row !== null) ? { ...row } : row;
                        chunk.push(cleanRow);
                        if (chunk.length >= chunkSize) {
                            const newMsg = RED.util.cloneMessage(msg);
                            objPath.set(newMsg, this.config.outputObj || "payload", chunk);
                            newMsg.odbc_stream = { index: rowCount - chunk.length, count: chunk.length, complete: false };
                            send(newMsg);
                            chunk = [];
                        }
                    }
                }
                if (chunk.length > 0) {
                    const newMsg = RED.util.cloneMessage(msg);
                    objPath.set(newMsg, this.config.outputObj || "payload", chunk);
                    newMsg.odbc_stream = { index: rowCount - chunk.length, count: chunk.length, complete: false };
                    send(newMsg);
                }
                const finalMsg = RED.util.cloneMessage(msg);
                objPath.set(finalMsg, this.config.outputObj || "payload", []);
                finalMsg.odbc_stream = { index: rowCount, count: 0, complete: true };
                send(finalMsg);
                this.status({ fill: "green", shape: "dot", text: `success (${rowCount} rows)` });
            } finally {
                if (cursor) {
                    try {
                        await Promise.race([
                            cursor.close(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Cursor close timeout')), this.cursorCloseOperationTimeout))
                        ]);
                    } catch (cursorCloseError) { this.warn(`Error or timeout closing cursor: ${cursorCloseError.message}`); }
                }
            }
        };

        this.testBasicConnectivity = async function(connection) {
            if (!connection || typeof connection.query !== 'function') {
                this.warn("Test de connectivité basique : connexion invalide fournie.");
                return false;
            }
            let originalTimeout;
            try {
                originalTimeout = connection.queryTimeout;
                connection.queryTimeout = 5; 
                await connection.query("SELECT 1");
                this.log("Test de connectivité basique (SELECT 1) : Réussi.");
                return true;
            } catch (testError) {
                this.warn(`Test de connectivité basique (SELECT 1) : Échoué - ${testError.message}`);
                return false;
            } finally {
                if (typeof originalTimeout !== 'undefined' && connection && typeof connection.query === 'function') {
                    try { connection.queryTimeout = originalTimeout; } 
                    catch(e) { this.warn("Impossible de restaurer le queryTimeout original après le test de connectivité.")}
                }
            }
        };

        this.getRenderedQueryAndParams = async function(msg) {
            const querySourceType = this.config.querySourceType || 'msg';
            const querySource = this.config.querySource || 'query';
            const paramsSourceType = this.config.paramsSourceType || 'msg';
            const paramsSource = this.config.paramsSource || 'parameters';
            
            this.currentParamsForErrorContext = await new Promise(resolve => RED.util.evaluateNodeProperty(paramsSource, paramsSourceType, this, msg, (err, val) => resolve(err ? undefined : val)));
            this.currentQueryForErrorContext = await new Promise(resolve => RED.util.evaluateNodeProperty(querySource, querySourceType, this, msg, (err, val) => resolve(err ? undefined : (val || this.config.query || ""))));
            
            if (!this.currentQueryForErrorContext) {
                throw new Error("No query to execute. Please provide a query in the node's configuration or via msg." + (querySourceType === 'msg' ? querySource : 'querySource (non-msg)'));
            }

            let finalQuery = this.currentQueryForErrorContext;
            const isPreparedStatement = this.currentParamsForErrorContext || (finalQuery && finalQuery.includes("?"));
            if (!isPreparedStatement && finalQuery) {
                finalQuery = mustache.render(finalQuery, msg);
            }
            return { query: finalQuery, params: this.currentParamsForErrorContext };
        };

        this.executeUserQuery = async function(connection, query, params, msg, send) {
            const configuredTimeout = parseInt(this.poolNode.config.queryTimeoutSeconds, 10);
            if (configuredTimeout > 0) {
                try { connection.queryTimeout = configuredTimeout; } 
                catch (e) { this.warn(`Could not set queryTimeout on connection: ${e.message}`); }
            } else {
                 connection.queryTimeout = 0; 
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

        this.on("input", async (msg, send, done) => {
            this.currentQueryForErrorContext = null; 
            this.currentParamsForErrorContext = null;

            if (this.isAwaitingRetry) {
                if (this.poolNode && this.poolNode.config.retryOnMsg === true) {
                    this.log("New message received, overriding retry timer and attempting query now.");
                    clearTimeout(this.retryTimer); this.retryTimer = null; this.isAwaitingRetry = false;
                } else {
                    this.warn("Node is in a retry-wait state. New message ignored.");
                    if (done) done(); return;
                }
            }
            this.isAwaitingRetry = false;
            if(this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }

            if (!this.poolNode) {
                this.status({ fill: "red", shape: "ring", text: "No config node" });
                return done(this.enhanceError(new Error("ODBC Config node not properly configured.")));
            }

            let queryToExecute;
            let paramsToExecute;
            try {
                const queryData = await this.getRenderedQueryAndParams(msg);
                queryToExecute = queryData.query;
                paramsToExecute = queryData.params;
            } catch (inputValidationError) {
                this.status({ fill: "red", shape: "ring", text: "Input Error" });
                return done(this.enhanceError(inputValidationError)); 
            }
            
            let activeConnection = null; 
            let errorForUser = null; 
            let shouldProceedToTimedRetry = false;

            try { 
                this.status({ fill: "yellow", shape: "dot", text: "connecting (pool)..." });
                activeConnection = await this.poolNode.connect();
                await this.executeUserQuery(activeConnection, queryToExecute, paramsToExecute, msg, send);
                
                done(); 
                
                if (activeConnection) { 
                    try { await activeConnection.close(); } catch(e) { this.warn("Error closing pool connection after success: " + e.message); }
                    activeConnection = null; 
                }
                return; 

            } catch (initialDbError) {
                this.warn(`Initial DB attempt failed: ${initialDbError.message}`);
                // Garder la requête originale pour le contexte d'erreur, même si une erreur de connexion se produit
                // this.currentQueryForErrorContext et this.currentParamsForErrorContext sont déjà settés par getRenderedQueryAndParams

                if (activeConnection) { 
                    const connStillGood = await this.testBasicConnectivity(activeConnection);
                    try { await activeConnection.close(); activeConnection = null; } 
                    catch(e){ this.warn("Error closing pool conn after initial error: "+e.message); activeConnection = null; }
                    
                    if (connStillGood) { 
                        this.status({ fill: "red", shape: "ring", text: "SQL error" });
                        return done(this.enhanceError(initialDbError)); 
                    }
                }
                
                if (this.poolNode.config.retryFreshConnection) {
                    this.warn("Attempting retry with a fresh connection.");
                    this.status({ fill: "yellow", shape: "dot", text: "Retrying (fresh)..." });
                    try {
                        const freshConnectConfig = this.poolNode.getFreshConnectionConfig();
                        activeConnection = await odbcModule.connect(freshConnectConfig);
                        this.log("Fresh connection established.");

                        const freshConnGood = await this.testBasicConnectivity(activeConnection);
                        if (!freshConnGood) {
                            errorForUser = this.enhanceError(new Error("Basic connectivity (SELECT 1) failed on fresh connection."), null, null, "Fresh Connection Test Failed");
                            shouldProceedToTimedRetry = true;
                            throw errorForUser; 
                        }
                        
                        await this.executeUserQuery(activeConnection, queryToExecute, paramsToExecute, msg, send);
                        
                        this.log("Query successful with fresh connection. Resetting pool.");
                        done();
                        
                        await this.poolNode.resetPool();
                        if (activeConnection) { 
                            try { await activeConnection.close(); } catch(e) { this.warn("Error closing fresh connection after success: " + e.message); }
                            activeConnection = null; 
                        }
                        return; 

                    } catch (freshErrorOrConnectivityFail) {
                        if (activeConnection) { try { await activeConnection.close(); activeConnection = null; } catch(e){this.warn("Error closing fresh conn after error: "+e.message);} }
                        
                        if (shouldProceedToTimedRetry) { 
                            // errorForUser a été setté par l'échec du SELECT 1 sur la connexion fraîche
                        } else { 
                            this.status({ fill: "red", shape: "ring", text: "SQL error (on retry)" });
                            return done(this.enhanceError(freshErrorOrConnectivityFail));
                        }
                    }
                } else { 
                    errorForUser = this.enhanceError(initialDbError, null, null, "Connection Error (no fresh retry)");
                    shouldProceedToTimedRetry = true;
                }
            }
            
            if (activeConnection) { // Sécurité supplémentaire pour fermer une connexion si elle est restée active
                try { await activeConnection.close(); } catch(e) { this.warn("Final cleanup: Error closing activeConnection: " + e.message); }
                activeConnection = null;
            }
            
            if (shouldProceedToTimedRetry && errorForUser) {
                const retryDelaySeconds = parseInt(this.poolNode.config.retryDelay, 10);
                if (retryDelaySeconds > 0) {
                    this.warn(`Connection issue. Scheduling retry in ${retryDelaySeconds}s. Error: ${errorForUser.message}`);
                    this.status({ fill: "red", shape: "ring", text: `Retry in ${retryDelaySeconds}s...` });
                    this.isAwaitingRetry = true;
                    this.retryTimer = setTimeout(() => {
                        this.isAwaitingRetry = false; this.retryTimer = null;
                        this.log(`Retry timer expired. Re-emitting message for node ${this.id || this.name}.`);
                        this.receive(msg); 
                    }, retryDelaySeconds * 1000);
                    return done(); 
                } else { 
                    this.status({ fill: "red", shape: "ring", text: "Connection Error" });
                    return done(errorForUser);
                }
            } else if (errorForUser) { 
                 this.status({ fill: "red", shape: "ring", text: "Error (No Timed Retry)" });
                 return done(errorForUser); // Cas où c'est une erreur SQL identifiée, pas de retry temporisé.
            } else {
                 // Ce chemin ne devrait pas être atteint si done() a été appelé dans un chemin de succès.
                 this.log("[ODBC Node] DEBUG: Reached unexpected end of on('input') path. Calling done().");
                 return done();
            }
        });
        
        this.on("close", (done) => {
            if (this.retryTimer) {
                clearTimeout(this.retryTimer); this.retryTimer = null; this.isAwaitingRetry = false;
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