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
        // La logique de retry complexe est temporairement retirée pour stabiliser le noeud.

        // Cette fonction reste inchangée
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
        
        // Cette fonction reste presque inchangée, elle est maintenant appelée depuis on("input")
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

        // =================================================================
        // NOUVELLE IMPLEMENTATION DU STREAMING
        // =================================================================
        this.executeStreamQuery = async (dbConnection, queryString, queryParams, msg, send) => {
        const chunkSize = parseInt(this.config.streamChunkSize) || 1;
        // La taille du fetch peut être optimisée, mais restons simple pour la clarté.
        const fetchSize = chunkSize > 50 ? 50 : chunkSize;
        let cursor;

        try {
            cursor = await dbConnection.query(queryString, queryParams, { cursor: true, fetchSize: fetchSize });
            this.status({ fill: "blue", shape: "dot", text: "streaming rows..." });

            let rowCount = 0;
            let chunk = [];

            // Boucle infinie qui sera rompue de l'intérieur
            while (true) {
                const rows = await cursor.fetch();

                // 1. VÉRIFIER D'ABORD LA FIN DU FLUX
                if (!rows || rows.length === 0) {
                    // Le flux de la base de données est terminé.
                    // Le contenu actuel de `chunk` est le tout dernier lot.
                    if (chunk.length > 0) {
                        const newMsg = RED.util.cloneMessage(msg);
                        objPath.set(newMsg, this.config.outputObj, chunk);
                        // C'est le message final, donc `complete` est TRUE.
                        newMsg.odbc_stream = { index: rowCount - chunk.length, count: chunk.length, complete: true };
                        send(newMsg);
                    } else if (rowCount === 0) {
                        // Gérer le cas où la requête ne retourne aucune ligne.
                        const newMsg = RED.util.cloneMessage(msg);
                        objPath.set(newMsg, this.config.outputObj, []);
                        newMsg.odbc_stream = { index: 0, count: 0, complete: true };
                        send(newMsg);
                    }
                    // Quitter la boucle car il n'y a plus rien à faire.
                    break;
                }

                // 2. S'IL Y A DES LIGNES, LES TRAITER
                for (const row of rows) {
                    rowCount++;
                    chunk.push(row);
                    if (chunk.length >= chunkSize) {
                        const newMsg = RED.util.cloneMessage(msg);
                        objPath.set(newMsg, this.config.outputObj, chunk);
                        // Ce lot n'est pas le dernier, donc `complete` est FALSE.
                        newMsg.odbc_stream = { index: rowCount - chunk.length, count: chunk.length, complete: false };
                        send(newMsg);
                        // Vider le lot pour le prochain remplissage.
                        chunk = [];
                    }
                }
            } // Fin de la boucle while

            this.status({ fill: "green", shape: "dot", text: `success (${rowCount} rows)` });

        } finally {
            if (cursor) {
                await cursor.close();
            }
        }
    };

        // =================================================================
        // NOUVELLE LOGIQUE D'ENTREE UNIFIEE
        // =================================================================
        this.on("input", async (msg, send, done) => {
            if (!this.poolNode) {
                const err = new Error("ODBC Config node not properly configured.");
                this.status({ fill: "red", shape: "ring", text: "No config node" });
                done(err);
                return;
            }

            let connection;
            try {
                this.status({ fill: "blue", shape: "dot", text: "preparing..." });
                this.config.outputObj = this.config.outputObj || "payload";

                // Obtenir la requête et les paramètres
                const querySourceType = this.config.querySourceType || 'msg';
                const querySource = this.config.querySource || 'query';
                const paramsSourceType = this.config.paramsSourceType || 'msg';
                const paramsSource = this.config.paramsSource || 'parameters';

                const currentQueryParams = await new Promise((resolve) => {
                    RED.util.evaluateNodeProperty(paramsSource, paramsSourceType, this, msg, (err, value) => resolve(err ? undefined : value));
                });

                let currentQueryString = await new Promise((resolve) => {
                     RED.util.evaluateNodeProperty(querySource, querySourceType, this, msg, (err, value) => resolve(err ? undefined : (value || this.config.query || "")));
                });
                
                if (!currentQueryString) { throw new Error("No query to execute"); }
                
                const isPreparedStatement = currentQueryParams || (currentQueryString && currentQueryString.includes("?"));
                if (!isPreparedStatement && currentQueryString) {
                    currentQueryString = mustache.render(currentQueryString, msg);
                }
                
                // Obtenir une connexion du pool
                this.status({ fill: "yellow", shape: "dot", text: "connecting..." });
                connection = await this.poolNode.connect();
                this.status({ fill: "blue", shape: "dot", text: "executing..." });

                if (this.config.streaming) {
                    await this.executeStreamQuery(connection, currentQueryString, currentQueryParams, msg, send);
                } else {
                    const newMsg = await this.executeQueryAndProcess(connection, currentQueryString, currentQueryParams, msg);
                    this.status({ fill: "green", shape: "dot", text: "success" });
                    send(newMsg);
                }
                
                // Si tout s'est bien passé, on appelle done() sans erreur
                done();

            } catch (err) {
                const finalError = this.enhanceError(err, null, null, "Query Execution Failed");
                this.status({ fill: "red", shape: "ring", text: "query error" });
                done(finalError); // On passe l'erreur à done() pour que Node-RED la gère

            } finally {
                if (connection) {
                    try {
                        await connection.close();
                    } catch (closeErr) {
                        this.warn(`Failed to close DB connection: ${closeErr.message}`);
                    }
                }
            }
        });
        
        this.on("close", (done) => {
            this.status({});
            // La logique de fermeture du pool est déjà dans le noeud de config
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