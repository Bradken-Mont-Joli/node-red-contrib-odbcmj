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
        this.isAwaitingRetry = false;
        this.retryTimer = null;

        this.enhanceError = (error, query, params, defaultMessage = "Query error") => {
            // ... (Pas de changement dans cette section)
        };

        this.executeQueryAndProcess = async (dbConnection, queryString, queryParams, isPreparedStatement, msg) => {
            // ... (Pas de changement dans cette section)
        };
        
        // =================================================================
        // DEBUT DE LA SECTION CORRIGÉE
        // =================================================================

        this.executeStreamQuery = async (queryString, queryParams, msg, send, done) => {
            const chunkSize = parseInt(this.config.streamChunkSize) || 1;
            let cursor;
            let rowCount = 0;
            let chunk = [];
            
            try {
                if (!this.poolNode) {
                    throw new Error("Le noeud de configuration ODBC n'est pas disponible.");
                }
                
                // CORRECTION : Obtenir la chaîne de connexion depuis le noeud de config
                const connectionString = this.poolNode._buildConnectionString();
                if (!connectionString) {
                    throw new Error("Impossible de construire une chaîne de connexion valide.");
                }
                
                // CORRECTION : Appeler .cursor() comme une fonction de haut niveau du module odbc
                cursor = await odbcModule.cursor(connectionString, queryString, queryParams);
                
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
            // La logique de cette fonction (séparation streaming / non-streaming) reste la même
            // que dans la correction précédente et est toujours valide.
            // ... (Le code de runQuery de la réponse précédente est ici)
            let isPreparedStatement = false;
            let connectionFromPool = null;

            try {
                this.status({ fill: "blue", shape: "dot", text: "preparing..." });
                this.config.outputObj = msg?.output || this.config?.outputObj || "payload";

                const querySourceType = this.config.querySourceType || 'msg';
                const querySource = this.config.querySource || 'query';
                const paramsSourceType = this.config.paramsSourceType || 'msg';
                const paramsSource = this.config.paramsSource || 'parameters';

                let currentQueryParams = await new Promise((resolve) => {
                    RED.util.evaluateNodeProperty(paramsSource, paramsSourceType, this, msg, (err, value) => {
                        resolve(err ? undefined : value);
                    });
                });

                let currentQueryString = await new Promise((resolve) => {
                     RED.util.evaluateNodeProperty(querySource, querySourceType, this, msg, (err, value) => {
                         resolve(err ? undefined : (value || this.config.query || ""));
                     });
                });
                
                if (!currentQueryString) { throw new Error("No query to execute"); }
                
                isPreparedStatement = currentQueryParams || (currentQueryString && currentQueryString.includes("?"));
                if (!isPreparedStatement && currentQueryString) {
                    for (const parsed of mustache.parse(currentQueryString)) {
                        if ((parsed[0] === "name" || parsed[0] === "&") && !objPath.has(msg, parsed[1])) {
                            this.warn(`Mustache parameter "${parsed[1]}" is absent.`);
                        }
                    }
                    currentQueryString = mustache.render(currentQueryString, msg);
                }

                if (this.config.streaming) {
                    await this.executeStreamQuery(currentQueryString, currentQueryParams, msg, send, done);
                } else {
                    const executeNonQuery = async (conn) => {
                        const processedMsg = await this.executeQueryAndProcess(conn, currentQueryString, currentQueryParams, isPreparedStatement, msg);
                        this.status({ fill: "green", shape: "dot", text: "success" });
                        send(processedMsg);
                        if(done) done();
                    };
                    
                    let firstAttemptError = null;
                    try {
                        connectionFromPool = await this.poolNode.connect();
                        await executeNonQuery(connectionFromPool);
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
                                await executeNonQuery(freshConnection);
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
                }
            } catch (err) {
                const finalError = err instanceof Error ? err : new Error(String(err));
                this.status({ fill: "red", shape: "ring", text: "query error" });
                if (done) { done(finalError); } else { this.error(finalError, msg); }
            }
        };

        // =================================================================
        // FIN DE LA SECTION CORRIGÉE
        // =================================================================
        
        this.checkPool = async function (msg, send, done) {
            try {
                if (!this.poolNode) { throw new Error("ODBC Config node not properly configured."); }
                
                // Pour le mode streaming, on n'a pas besoin d'attendre l'initialisation du *pool*,
                // mais on a besoin du noeud de config.
                if (this.config.streaming) {
                    await this.runQuery(msg, send, done);
                    return;
                }
                
                // La logique ci-dessous ne s'applique qu'au mode non-streaming
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
                if (!this.poolNode.pool) {
                    await this.poolNode.connect().then(c => c.close());
                }
                await this.runQuery(msg, send, done);
            } catch (err) {
                const finalError = err instanceof Error ? err : new Error(String(err));
                this.status({ fill: "red", shape: "dot", text: "Op failed" });
                if (done) { done(finalError); } else { this.error(finalError, msg); }
            }
        };

        this.on("input", async (msg, send, done) => {
            // ... (Pas de changement dans cette section)
        });

        this.on("close", async (done) => {
            // ... (Pas de changement dans cette section)
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