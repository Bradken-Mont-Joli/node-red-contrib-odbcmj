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

        // NOUVEAU: Timeout par défaut pour les requêtes (0 = infini/défaut du driver)
        // Sera configurable dans le .html plus tard
        this.config.queryTimeoutSeconds = parseInt(config.queryTimeoutSeconds, 10) || 0; 
        // NOUVEAU: Timeout fixe pour les opérations de fermeture (en ms)
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
                // NOUVEAU: Potentiellement ajouter des options de timeout ici si le driver les supporte dans la CS
                // Exemple (non standard, dépend du driver): if (this.config.loginTimeout > 0) parts.push(`LoginTimeout=${this.config.loginTimeout}`);
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
                    
                    const poolParams = { ...this.config }; // Contient initialSize, maxSize, loginTimeout, connectionTimeout (idle) etc.
                    poolParams.connectionString = finalConnectionString;

                    // Supprimer les clés non reconnues par odbc.pool ou spécifiques à notre nœud
                    ['retryFreshConnection', 'retryDelay', 'retryOnMsg', 'syntax', 'connectionMode', 
                     'dbType', 'server', 'database', 'user', 'driver', 'queryTimeoutSeconds', 'name', 'id', 'type', '_users', 'z', 'x', 'y', 'wires']
                     .forEach(k => delete poolParams[k]);
                    
                    // NOUVEAU: Debug des paramètres du pool
                    // this.log(`Initializing pool with params: ${JSON.stringify(poolParams)}`);

                    // Potentiel point de blocage si odbcModule.pool() ne gère pas bien les erreurs de driver/connexion
                    // Il n'y a pas de timeout direct pour odbcModule.pool() lui-même
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
                // odbc.pool.connect() peut aussi théoriquement bloquer, mais devrait utiliser
                // les timeouts des connexions individuelles ou le connectionTimeout du pool (pour l'attente d'une connexion dispo)
                return await this.pool.connect();
            } catch (poolConnectError) {
                this.error(`Error connecting to pool: ${poolConnectError.message}`, poolConnectError);
                this.status({ fill: "red", shape: "ring", text: "Pool connect err" });
                throw poolConnectError;
            }
        };

        this.getFreshConnectionConfig = function() {
            // Ces timeouts sont pour odbcModule.connect (connexion unique)
            return {
                connectionString: this._buildConnectionString(),
                connectionTimeout: 0, // Pour une connexion unique, on ne veut pas qu'elle se ferme automatiquement après un idle time.
                                      // Le `connectionTimeout` de node-odbc connect est "Number of seconds for the connection to be open before it is automatically closed."
                loginTimeout: parseInt(this.config.loginTimeout, 10) || 5, // Timeout pour l'établissement de la connexion. 5s par défaut.
            };
        };

        // MODIFIÉ: Ajout de timeout pour pool.close()
        this.resetPool = async () => {
            if (this.pool) {
                this.log("Resetting connection pool.");
                this.status({ fill: "yellow", shape: "ring", text: "Resetting pool..." });
                let closedSuccessfully = false;
                try {
                    await Promise.race([
                        this.pool.close(),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Pool close timeout')), this.closeOperationTimeout)
                        )
                    ]);
                    this.log("Connection pool closed successfully for reset.");
                    closedSuccessfully = true;
                } catch (closeError) {
                    this.error(`Error or timeout closing pool during reset: ${closeError.message}`, closeError);
                } finally {
                    this.pool = null;
                    this.connecting = false;
                    if (closedSuccessfully) {
                        this.status({ fill: "grey", shape: "ring", text: "Pool reset" });
                    } else {
                        this.status({ fill: "red", shape: "ring", text: "Pool reset failed" });
                    }
                }
            } else {
                this.log("Pool reset requested, but no active pool to reset.");
            }
        };

        // MODIFIÉ: Ajout de timeout pour pool.close()
        this.on("close", async (removed, done) => {
            this.log("Closing ODBC config node. Attempting to close pool.");
            if (this.pool) {
                try {
                    await Promise.race([
                        this.pool.close(),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Pool close timeout on node close')), this.closeOperationTimeout)
                        )
                    ]);
                    this.log("Connection pool closed successfully on node close.");
                } catch (error) {
                    this.error(`Error or timeout closing connection pool on node close: ${error.message}`, error);
                } finally {
                    this.pool = null; // S'assurer que le pool est marqué comme null
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

        const buildTestConnectionString = () => {
            if (tempConfig.connectionMode === 'structured') {
                if (!tempConfig.dbType || !tempConfig.server) {
                    throw new Error("En mode structuré, le type de base de données et le serveur sont requis.");
                }
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
            console.log("[ODBC Test] Attempting to connect with string:", testConnectionString);
            
            const connectionOptions = {
                connectionString: testConnectionString,
                loginTimeout: 10 // Déjà présent et correct
            };
            connection = await odbcModule.connect(connectionOptions);
            res.sendStatus(200);
        } catch (err) {
            console.error("[ODBC Test] Connection failed:", err);
            res.status(500).send(err.message || "Erreur inconnue durant le test.");
        } finally {
            if (connection) {
                await connection.close(); // Fermeture simple, pas besoin de timeout ici car c'est une op rapide.
            }
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

        // NOUVEAU: Timeout fixe pour les opérations de fermeture de curseur (en ms)
        this.cursorCloseOperationTimeout = 5000; // 5 secondes

        this.enhanceError = (error, query, params, defaultMessage = "Query error") => { /* ... (inchangé) ... */ };
        this.executeQueryAndProcess = async (dbConnection, queryString, queryParams, msg) => { /* ... (inchangé) ... */ };
        
        // MODIFIÉ: Ajout de timeout pour cursor.close()
        this.executeStreamQuery = async (dbConnection, queryString, queryParams, msg, send) => {
            const chunkSize = parseInt(this.config.streamChunkSize) || 1;
            const fetchSize = chunkSize > 100 ? 100 : chunkSize; 
            let cursor;
        
            try {
                // dbConnection.query() utilisera le dbConnection.queryTimeout défini plus bas
                cursor = await dbConnection.query(queryString, queryParams, { cursor: true, fetchSize: fetchSize });
                this.status({ fill: "blue", shape: "dot", text: "streaming rows..." });
        
                let rowCount = 0;
                let chunk = [];
        
                while (true) {
                    // cursor.fetch() pourrait aussi théoriquement bloquer, mais c'est plus rare si la requête initiale a fonctionné
                    const rows = await cursor.fetch(); 
                    if (!rows || rows.length === 0) { break; }
        
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
                    try {
                        // NOUVEAU: Timeout pour la fermeture du curseur
                        await Promise.race([
                            cursor.close(),
                            new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('Cursor close timeout')), this.cursorCloseOperationTimeout)
                            )
                        ]);
                    } catch (cursorCloseError) {
                        this.warn(`Error or timeout closing cursor: ${cursorCloseError.message}`);
                    }
                }
            }
        };

        // MODIFIÉ: Ajout de la définition du queryTimeout sur la connexion
        this.on("input", async (msg, send, done) => {
            if (this.isAwaitingRetry) {
                if (this.poolNode && this.poolNode.config.retryOnMsg === true) {
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
            this.isAwaitingRetry = false;
            if(this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }

            if (!this.poolNode) {
                this.status({ fill: "red", shape: "ring", text: "No config node" });
                return done(new Error("ODBC Config node not properly configured."));
            }
    
            const executeWithConnection = async (connection) => {
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

                // NOUVEAU: Appliquer le queryTimeout à la connexion avant exécution
                if (this.poolNode.config.queryTimeoutSeconds > 0) {
                    try {
                        connection.queryTimeout = parseInt(this.poolNode.config.queryTimeoutSeconds, 10);
                        // this.log(`Query timeout set to ${connection.queryTimeout}s for this execution.`);
                    } catch (e) {
                        this.warn(`Could not set queryTimeout on connection: ${e.message}`);
                    }
                } else {
                     connection.queryTimeout = 0; // Assurer le reset au défaut du driver (infini)
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
            let errorAfterInitialAttempts = null;
    
            try {
                this.status({ fill: "yellow", shape: "dot", text: "connecting..." });
                connectionFromPool = await this.poolNode.connect();
                await executeWithConnection(connectionFromPool);
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
                        await executeWithConnection(freshConnection);
                        this.log("Query successful with fresh connection. Resetting pool.");
                        await this.poolNode.resetPool();
                        return done();
                    } catch (freshError) {
                        errorAfterInitialAttempts = this.enhanceError(freshError, null, null, "Retry with fresh connection also failed");
                    } finally {
                        if (freshConnection) await freshConnection.close();
                    }
                } else {
                    errorAfterInitialAttempts = this.enhanceError(poolError);
                }
            } finally {
                if (connectionFromPool) await connectionFromPool.close();
            }
    
            if (errorAfterInitialAttempts) {
                const retryDelaySeconds = parseInt(this.poolNode.config.retryDelay, 10);
                if (retryDelaySeconds > 0) {
                    this.warn(`Query failed. Scheduling retry in ${retryDelaySeconds} seconds. Error: ${errorAfterInitialAttempts.message}`);
                    this.status({ fill: "red", shape: "ring", text: `Retry in ${retryDelaySeconds}s...` });
                    this.isAwaitingRetry = true;
                    this.retryTimer = setTimeout(() => {
                        this.isAwaitingRetry = false;
                        this.retryTimer = null;
                        this.log(`Retry timer expired for message. Re-emitting for node ${this.id || this.name}.`);
                        this.receive(msg); 
                    }, retryDelaySeconds * 1000);
                    if (done) return done();
                } else {
                    this.status({ fill: "red", shape: "ring", text: "query error" });
                    if (done) return done(errorAfterInitialAttempts);
                }
            } else {
                if (done) return done();
            }
        });
        
        this.on("close", (done) => {
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = null;
                this.isAwaitingRetry = false;
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