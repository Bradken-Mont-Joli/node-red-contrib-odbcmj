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
        this.closeOperationTimeout = 10000;

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
        // ... (Logique du testeur de connexion - INCHANGÉE par rapport à votre dernière version)
        const tempConfig = req.body;
        const buildTestConnectionString = () => { /* ... */ }; // Définition interne
        let connection;
        try {
            const testConnectionString = buildTestConnectionString(); // Utilise la définition interne
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
        this.currentQueryForErrorContext = null; // Pour stocker la requête lors du traitement
        this.currentParamsForErrorContext = null; // Pour stocker les paramètres lors du traitement


        this.enhanceError = (error, query, params, defaultMessage = "Query error") => {
            // Utilise this.currentQueryForErrorContext et this.currentParamsForErrorContext s'ils sont définis
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

        this.executeQueryAndProcess = async (dbConnection, queryString, queryParams, msg) => { /* ... (inchangé) ... */ };
        this.executeStreamQuery = async (dbConnection, queryString, queryParams, msg, send) => { /* ... (inchangé) ... */ };

        // NOUVELLE fonction utilitaire
        async function testBasicConnectivity(connection, nodeInstance) {
            if (!connection || typeof connection.query !== 'function') {
                nodeInstance.warn("Test de connectivité basique : connexion invalide fournie.");
                return false;
            }
            try {
                const originalTimeout = connection.queryTimeout;
                connection.queryTimeout = 5; // Court timeout pour un SELECT 1
                await connection.query("SELECT 1"); // Ou équivalent SGBD
                connection.queryTimeout = originalTimeout;
                nodeInstance.log("Test de connectivité basique (SELECT 1) : Réussi.");
                return true;
            } catch (testError) {
                nodeInstance.warn(`Test de connectivité basique (SELECT 1) : Échoué - ${testError.message}`);
                return false;
            }
        }

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
                return done(new Error("ODBC Config node not properly configured."));
            }
    
            const getRenderedQueryAndParams = async () => {
                const querySourceType = this.config.querySourceType || 'msg';
                const querySource = this.config.querySource || 'query';
                const paramsSourceType = this.config.paramsSourceType || 'msg';
                const paramsSource = this.config.paramsSource || 'parameters';
                
                this.currentParamsForErrorContext = await new Promise(resolve => RED.util.evaluateNodeProperty(paramsSource, paramsSourceType, this, msg, (err, val) => resolve(err ? undefined : val)));
                this.currentQueryForErrorContext = await new Promise(resolve => RED.util.evaluateNodeProperty(querySource, querySourceType, this, msg, (err, val) => resolve(err ? undefined : (val || this.config.query || ""))));
                
                if (!this.currentQueryForErrorContext) throw new Error("No query to execute");

                let finalQuery = this.currentQueryForErrorContext;
                const isPreparedStatement = this.currentParamsForErrorContext || (finalQuery && finalQuery.includes("?"));
                if (!isPreparedStatement && finalQuery) {
                    finalQuery = mustache.render(finalQuery, msg);
                }
                return { query: finalQuery, params: this.currentParamsForErrorContext };
            };

            const executeUserQuery = async (connection, query, params) => {
                // Appliquer le queryTimeout configuré
                const configuredTimeout = parseInt(this.poolNode.config.queryTimeoutSeconds, 10);
                if (configuredTimeout > 0) {
                    try { connection.queryTimeout = configuredTimeout; } 
                    catch (e) { this.warn(`Could not set queryTimeout on connection: ${e.message}`); }
                } else {
                     connection.queryTimeout = 0; // Infini ou défaut driver
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
    
            let activeConnection = null; // Pour gérer la connexion active (pool ou fraîche)
            let shouldProceedToTimedRetry = false;
            let errorForTimedRetry = null;
    
            try { // Tentative Principale (avec connexion du pool)
                const { query, params } = await getRenderedQueryAndParams();
                
                this.status({ fill: "yellow", shape: "dot", text: "connecting (pool)..." });
                activeConnection = await this.poolNode.connect();
                await executeUserQuery(activeConnection, query, params);
                
                if (activeConnection) { await activeConnection.close(); activeConnection = null; }
                return done();

            } catch (initialError) {
                this.warn(`Initial attempt failed: ${initialError.message}`);
                if (activeConnection) { // Si la connexion a été obtenue mais que executeUserQuery a échoué
                    const connStillGood = await testBasicConnectivity(activeConnection, this);
                    try { await activeConnection.close(); activeConnection = null; } catch(e){this.warn("Error closing pool conn after initial error: "+e.message);}
                    
                    if (connStillGood) { // La connexion est bonne, l'erreur vient de la requête utilisateur
                        this.status({ fill: "red", shape: "ring", text: "SQL error" });
                        return done(this.enhanceError(initialError, this.currentQueryForErrorContext, this.currentParamsForErrorContext, "SQL Query Error"));
                    }
                }
                // Si on arrive ici, la connexion poolée a eu un problème (soit pour se connecter, soit SELECT 1 a échoué)

                if (this.poolNode.config.retryFreshConnection) {
                    this.warn("Attempting retry with a fresh connection.");
                    this.status({ fill: "yellow", shape: "dot", text: "Retrying (fresh)..." });
                    try {
                        const freshConnectConfig = this.poolNode.getFreshConnectionConfig();
                        activeConnection = await odbcModule.connect(freshConnectConfig);
                        this.log("Fresh connection established.");

                        const freshConnGood = await testBasicConnectivity(activeConnection, this);
                        if (!freshConnGood) {
                            // Erreur de connectivité même sur une connexion fraîche
                            errorForTimedRetry = this.enhanceError(new Error("Basic connectivity (SELECT 1) failed on fresh connection."), this.currentQueryForErrorContext, this.currentParamsForErrorContext, "Fresh Connection Test Failed");
                            shouldProceedToTimedRetry = true;
                            throw errorForTimedRetry; // Va au catch externe de ce bloc try-fresh
                        }
                        
                        // La connexion fraîche est bonne, on retente la requête utilisateur originale
                        const { query, params } = await getRenderedQueryAndParams(); // Re-préparer au cas où
                        await executeUserQuery(activeConnection, query, params);
                        
                        this.log("Query successful with fresh connection. Resetting pool.");
                        await this.poolNode.resetPool();
                        if (activeConnection) { await activeConnection.close(); activeConnection = null; }
                        return done(); // Succès !

                    } catch (freshErrorOrConnectivityFail) {
                        // Soit odbcModule.connect a échoué, soit SELECT 1 a échoué (et errorForTimedRetry est déjà setté),
                        // soit executeUserQuery sur la connexion fraîche a échoué.
                        if (activeConnection) { try { await activeConnection.close(); activeConnection = null; } catch(e){this.warn("Error closing fresh conn after error: "+e.message);} }
                        
                        if (shouldProceedToTimedRetry) { // Signifie que SELECT 1 sur la connexion fraîche a échoué
                            // errorForTimedRetry est déjà setté
                        } else { 
                            // SELECT 1 sur connexion fraîche a réussi, mais la requête utilisateur a échoué. C'est une erreur SQL.
                            this.status({ fill: "red", shape: "ring", text: "SQL error (on retry)" });
                            return done(this.enhanceError(freshErrorOrConnectivityFail, this.currentQueryForErrorContext, this.currentParamsForErrorContext, "SQL Query Error (on fresh connection)"));
                        }
                    }
                } else { // Pas de retryFreshConnection configuré, l'erreur initiale était donc un problème de connexion.
                    errorForTimedRetry = this.enhanceError(initialError, this.currentQueryForErrorContext, this.currentParamsForErrorContext, "Connection Error");
                    shouldProceedToTimedRetry = true;
                }
            }
            
            // Logique de Retry Temporisé
            if (shouldProceedToTimedRetry && errorForTimedRetry) {
                const retryDelaySeconds = parseInt(this.poolNode.config.retryDelay, 10);
                if (retryDelaySeconds > 0) {
                    this.warn(`Connection issue suspected. Scheduling retry in ${retryDelaySeconds} seconds. Error: ${errorForTimedRetry.message}`);
                    this.status({ fill: "red", shape: "ring", text: `Retry in ${retryDelaySeconds}s...` });
                    this.isAwaitingRetry = true;
                    this.retryTimer = setTimeout(() => {
                        this.isAwaitingRetry = false; this.retryTimer = null;
                        this.log(`Retry timer expired. Re-emitting message for node ${this.id || this.name}.`);
                        this.receive(msg); 
                    }, retryDelaySeconds * 1000);
                    return done(); // Termine l'invocation actuelle du message
                } else { // Pas de délai de retry, ou délai à 0
                    this.status({ fill: "red", shape: "ring", text: "Connection Error" });
                    return done(errorForTimedRetry);
                }
            } else if (errorForTimedRetry) { // Une erreur SQL a été identifiée et ne doit pas déclencher de retry de connexion
                 this.status({ fill: "red", shape: "ring", text: "Error (No Retry)" });
                 return done(errorForTimedRetry); // Devrait déjà avoir été fait
            } else {
                 // Normalement, on ne devrait pas arriver ici si done() a été appelé après un succès.
                 this.log("[ODBC Node] DEBUG: Reached end of on('input') without error or prior done(). Calling done().");
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