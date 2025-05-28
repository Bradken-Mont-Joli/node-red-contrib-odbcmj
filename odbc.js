module.exports = function (RED) {
    const odbcModule = require("odbc");
    const mustache = require("mustache");
    const objPath = require("object-path");

    // --- ODBC Configuration Node ---
    function poolConfig(config) {
        RED.nodes.createNode(this, config);
        this.config = config; // Contient connectionString, initialSize, retryFreshConnection, etc.
        this.pool = null;
        this.connecting = false;

        const enableSyntaxChecker = this.config.syntaxtick;
        const syntax = this.config.syntax;
        // Garder une copie de la config originale pour la connexion fraîche si besoin
        this.originalConfigForFreshConnection = {
            connectionString: this.config.connectionString,
            connectionTimeout: parseInt(this.config.connectionTimeout) || 0, // Assurer un integer, 0 pour certains drivers signifie pas de timeout spécifique à l'appel connect
            loginTimeout: parseInt(this.config.loginTimeout) || 0,
        };

        delete this.config.syntaxtick; // Ces champs ne sont pas pour odbc.pool directement
        // delete this.config.syntax; // 'syntax' pourrait être utile si odbc.pool l'acceptait

        this.parser = enableSyntaxChecker
            ? new require("node-sql-parser/build/" + syntax).Parser()
            : null;

        for (const [key, value] of Object.entries(this.config)) {
            if (!isNaN(parseInt(value))) {
                this.config[key] = parseInt(value);
            }
        }
        // 'retryFreshConnection' est déjà dans this.config grâce à la création du noeud

        this.connect = async () => {
            // Si le pool n'existe pas (ou a été reset), on le crée
            if (!this.pool) {
                this.connecting = true;
                this.status({
                    fill: "yellow",
                    shape: "dot",
                    text: "Pool init...",
                });
                try {
                    // Utiliser une copie de la config sans retryFreshConnection pour odbc.pool
                    const poolParams = { ...this.config };
                    delete poolParams.retryFreshConnection;
                    delete poolParams.syntax; // Retiré car non utilisé par odbc.pool

                    this.pool = await odbcModule.pool(poolParams);
                    this.connecting = false;
                    this.status({
                        fill: "green",
                        shape: "dot",
                        text: "Pool ready",
                    });
                    this.log("Connection pool initialized successfully.");
                } catch (error) {
                    this.connecting = false;
                    this.error(
                        `Error creating connection pool: ${error}`,
                        error
                    );
                    this.status({
                        fill: "red",
                        shape: "ring",
                        text: "Pool error",
                    });
                    throw error;
                }
            }
            // Quoi qu'il arrive, on demande une connexion au pool (qui pourrait être fraîchement créé)
            try {
                return await this.pool.connect();
            } catch (poolConnectError) {
                this.error(
                    `Error connecting to pool: ${poolConnectError}`,
                    poolConnectError
                );
                this.status({
                    fill: "red",
                    shape: "ring",
                    text: "Pool connect err",
                });
                throw poolConnectError;
            }
        };

        // --- NOUVELLE MÉTHODE: resetPool ---
        this.resetPool = async () => {
            if (this.pool) {
                this.log("Resetting connection pool.");
                this.status({
                    fill: "yellow",
                    shape: "ring",
                    text: "Resetting pool...",
                });
                try {
                    await this.pool.close();
                    this.log("Connection pool closed successfully for reset.");
                } catch (closeError) {
                    this.error(
                        `Error closing pool during reset: ${closeError}`,
                        closeError
                    );
                    // Continuer pour nullifier le pool même en cas d'erreur de fermeture
                } finally {
                    this.pool = null;
                    this.connecting = false; // Permet à this.connect de recréer le pool
                    // Le statut sera mis à jour par la prochaine tentative de connexion via this.connect()
                }
            } else {
                this.log("Pool reset requested, but no active pool to reset.");
            }
        };

        this.on("close", async (removed, done) => {
            // 'removed' est true si le noeud est supprimé, false si juste redéployé.
            // Nous voulons fermer le pool dans les deux cas si nous en sommes propriétaires.
            this.log("Closing ODBC config node. Attempting to close pool.");
            if (this.pool) {
                try {
                    await this.pool.close();
                    this.log(
                        "Connection pool closed successfully on node close."
                    );
                    this.pool = null;
                } catch (error) {
                    this.error(
                        `Error closing connection pool on node close: ${error}`,
                        error
                    );
                }
            }
            done();
        });
    }

    RED.nodes.registerType("odbc config", poolConfig);

    // --- ODBC Query Node ---
    function odbc(config) {
        RED.nodes.createNode(this, config);
        this.config = config;
        this.poolNode = RED.nodes.getNode(this.config.connection); // C'est le noeud 'odbc config'
        this.name = this.config.name;

        // --- NOUVELLE MÉTHODE: Helper pour améliorer les messages d'erreur ---
        this.enhanceError = (
            error,
            query,
            params,
            defaultMessage = "Query error"
        ) => {
            const queryContext = (() => {
                let s = "";
                if (query || params) {
                    s += " {";
                    if (query)
                        s += `"query": '${query.substring(0, 100)}${
                            query.length > 100 ? "..." : ""
                        }'`; // Tronquer les longues requêtes
                    if (params) s += `, "params": '${JSON.stringify(params)}'`;
                    s += "}";
                    return s;
                }
                return "";
            })();

            let finalError;
            if (typeof error === "object" && error !== null && error.message) {
                finalError = error;
            } else if (typeof error === "string") {
                finalError = new Error(error);
            } else {
                finalError = new Error(defaultMessage);
            }

            finalError.message = `${finalError.message}${queryContext}`;
            if (query) finalError.query = query;
            if (params) finalError.params = params;

            return finalError;
        };

        // --- NOUVELLE MÉTHODE: Helper pour exécuter la requête et traiter le résultat ---
        // Prend une connexion (du pool ou fraîche) en argument
        this.executeQueryAndProcess = async (
            dbConnection,
            queryString,
            queryParams,
            isPreparedStatement,
            msg
        ) => {
            let result;
            // Exécution de la requête
            if (isPreparedStatement) {
                const stmt = await dbConnection.createStatement();
                try {
                    await stmt.prepare(queryString);
                    await stmt.bind(queryParams); // queryParams vient de msg.parameters
                    result = await stmt.execute();
                } finally {
                    // Assurer la fermeture du statement même en cas d'erreur de execute()
                    // stmt.close() peut être synchrone ou asynchrone selon les drivers/versions de odbc
                    if (stmt && typeof stmt.close === "function") {
                        try {
                            await stmt.close();
                        } catch (stmtCloseError) {
                            this.warn(
                                `Error closing statement: ${stmtCloseError}`
                            );
                        }
                    }
                }
            } else {
                result = await dbConnection.query(queryString, queryParams); // queryParams ici aussi
            }

            if (typeof result === "undefined") {
                // Certains drivers/erreurs pourraient retourner undefined
                throw new Error(
                    "Query returned undefined. Check for errors or empty results."
                );
            }

            // Traitement du résultat (SQL_BIT, otherParams, etc.)
            // Créer une copie du message pour éviter de modifier l'original en cas de retry
            const newMsg = RED.util.cloneMessage(msg);

            const otherParams = {};
            let actualDataRows = [];

            if (result !== null && typeof result === "object") {
                // Si result est un array, il contient les lignes.
                // Les propriétés non-numériques (comme .columns, .count) sont extraites.
                if (Array.isArray(result)) {
                    actualDataRows = [...result]; // Copie des lignes
                    for (const [key, value] of Object.entries(result)) {
                        if (isNaN(parseInt(key))) {
                            otherParams[key] = value;
                        }
                    }
                } else {
                    // Si result est un objet mais pas un array (ex: { count: 0, columns: [...] })
                    // Il n'y a pas de "lignes" au sens array, mais otherParams peut contenir des metadonnées.
                    for (const [key, value] of Object.entries(result)) {
                        otherParams[key] = value;
                    }
                }
            }

            const columnMetadata = otherParams.columns;
            if (
                Array.isArray(columnMetadata) &&
                Array.isArray(actualDataRows) &&
                actualDataRows.length > 0
            ) {
                const sqlBitColumnNames = new Set();
                columnMetadata.forEach((col) => {
                    if (
                        col &&
                        typeof col.name === "string" &&
                        col.dataTypeName === "SQL_BIT"
                    ) {
                        sqlBitColumnNames.add(col.name);
                    }
                });

                if (sqlBitColumnNames.size > 0) {
                    actualDataRows.forEach((row) => {
                        if (typeof row === "object" && row !== null) {
                            for (const columnName of sqlBitColumnNames) {
                                if (row.hasOwnProperty(columnName)) {
                                    const value = row[columnName];
                                    if (value === "1" || value === 1) {
                                        row[columnName] = true;
                                    } else if (value === "0" || value === 0) {
                                        row[columnName] = false;
                                    }
                                }
                            }
                        }
                    });
                }
            }

            objPath.set(newMsg, this.config.outputObj, actualDataRows);

            if (this.poolNode?.parser && queryString) {
                try {
                    // Utiliser structuredClone est une bonne pratique pour éviter les modifications par référence
                    newMsg.parsedQuery = this.poolNode.parser.astify(
                        structuredClone(queryString)
                    );
                } catch (syntaxError) {
                    this.warn(
                        `Could not parse query for parsedQuery output: ${syntaxError}`
                    );
                }
            }

            if (Object.keys(otherParams).length) {
                newMsg.odbc = otherParams;
            }
            return newMsg;
        };

        this.runQuery = async function (msg, send, done) {
            let currentQueryString = this.config.query || ""; // Initialiser avec la config du noeud
            let currentQueryParams = msg.parameters; // Peut être undefined
            let isPreparedStatement = false;
            let connectionFromPool = null; // Pour s'assurer de sa fermeture

            try {
                this.status({
                    fill: "blue",
                    shape: "dot",
                    text: "querying...",
                });
                this.config.outputObj =
                    msg?.output || this.config?.outputObj || "payload";

                // --- Construction de la requête (adapté de l'original) ---
                // Déterminer si c'est un prepared statement AVANT le render mustache
                isPreparedStatement =
                    currentQueryParams ||
                    (currentQueryString && currentQueryString.includes("?"));

                if (!isPreparedStatement && currentQueryString) {
                    // Mustache rendering uniquement si ce n'est pas un PS avec des '?'
                    // Et si currentQueryString est défini
                    for (const parsed of mustache.parse(currentQueryString)) {
                        if (parsed[0] === "name" || parsed[0] === "&") {
                            if (!objPath.has(msg, parsed[1])) {
                                this.warn(
                                    `Mustache parameter "${parsed[1]}" is absent and will render to undefined`
                                );
                            }
                        }
                    }
                    currentQueryString = mustache.render(
                        currentQueryString,
                        msg
                    );
                }

                if (msg?.query) {
                    // Priorité à msg.query
                    if (
                        currentQueryString &&
                        currentQueryString !== this.config.query
                    ) {
                        this.log(
                            "Query from node config (possibly mustache rendered) was overwritten by msg.query."
                        );
                    } else if (this.config.query) {
                        this.log(
                            "Query from node config was overwritten by msg.query."
                        );
                    }
                    currentQueryString = msg.query;
                } else if (msg?.payload) {
                    // Ensuite msg.payload.query ou msg.payload (si string)
                    if (typeof msg.payload === "string") {
                        try {
                            const payloadJson = JSON.parse(msg.payload);
                            if (
                                payloadJson?.query &&
                                typeof payloadJson.query === "string"
                            ) {
                                currentQueryString = payloadJson.query;
                            }
                        } catch (err) {
                            /* Pas un JSON ou pas de query, on ignore */
                        }
                    } else if (
                        msg.payload?.query &&
                        typeof msg.payload.query === "string"
                    ) {
                        currentQueryString = msg.payload.query;
                    }
                }

                if (!currentQueryString) {
                    throw new Error("No query to execute");
                }

                // Re-vérifier isPreparedStatement si query a changé, et valider les paramètres
                isPreparedStatement =
                    currentQueryParams ||
                    (currentQueryString && currentQueryString.includes("?"));

                if (isPreparedStatement) {
                    if (!currentQueryParams) {
                        throw new Error(
                            "Prepared statement ('?' in query) requires msg.parameters to be provided."
                        );
                    }
                    if (
                        typeof currentQueryParams === "object" &&
                        !Array.isArray(currentQueryParams)
                    ) {
                        // Tentative de mapper un objet à un array basé sur les noms dans la query (simplifié)
                        // Cette logique est complexe et sujette à erreur si les noms ne matchent pas parfaitement.
                        // La documentation originale suggère un mapping auto, mais c'est risqué.
                        // Pour l'instant, on se fie à l'ordre si c'est un objet.
                        // Une solution plus robuste serait d'analyser la query pour les noms de paramètres si le driver le supporte.
                        // Ou d'exiger un array pour les '?'
                        // Pour l'instant, on va assumer que si c'est un objet, l'utilisateur a une logique spécifique ou le driver le gère
                        // La logique originale de mappage par nom de paramètre dans `()` est retirée pour simplification,
                        // car elle est très spécifique et peut ne pas être standard.
                        // this.warn("msg.parameters is an object for a '?' prepared statement. Order of properties will be used. For explicit order, use an array.");
                        // currentQueryParams = Object.values(currentQueryParams); // Ceci est une supposition sur l'ordre.
                        // La meilleure approche est de demander un Array pour les '?'
                        if (
                            (currentQueryString.match(/\?/g) || []).length !==
                                Object.keys(currentQueryParams).length &&
                            (currentQueryString.match(/\?/g) || []).length !==
                                currentQueryParams.length
                        ) {
                            // La logique originale pour mapper les noms de paramètres pour les '?' était `this.queryString.match(/\(([^)]*)\)/)[1].split(",").map((el) => el.trim());`
                            // Ceci n'est pas standard pour les `?`. Normalement, `?` attend un array.
                            // On va laisser le driver/odbc gérer si `msg.parameters` est un objet.
                            // Mais on va vérifier le nombre de `?` vs la taille de `msg.parameters` si c'est un array.
                            // Si c'est un objet, on ne peut pas facilement vérifier le nombre.
                        }
                    }
                    if (
                        !Array.isArray(currentQueryParams) &&
                        typeof currentQueryParams !== "object"
                    ) {
                        // Doit être array ou objet
                        throw new Error(
                            "msg.parameters must be an array or an object for prepared statements."
                        );
                    }
                    if (
                        Array.isArray(currentQueryParams) &&
                        (currentQueryString.match(/\?/g) || []).length !==
                            currentQueryParams.length
                    ) {
                        throw new Error(
                            "Incorrect number of parameters in msg.parameters array for '?' placeholders."
                        );
                    }
                }

                // Validation du champ de sortie
                if (!this.config.outputObj) {
                    throw new Error(
                        "Invalid output object definition (outputObj is empty)"
                    );
                }
                const reg = new RegExp(
                    '^((?![,;:`\\[\\]{}+=()!"$%?&*|<>\\/^¨`\\s]).)*$'
                );
                if (
                    !this.config.outputObj.match(reg) ||
                    this.config.outputObj.startsWith(".") ||
                    this.config.outputObj.endsWith(".")
                ) {
                    throw new Error(
                        `Invalid output field name: ${this.config.outputObj}`
                    );
                }

                // --- Première tentative avec une connexion du pool ---
                let firstAttemptError = null;
                try {
                    connectionFromPool = await this.poolNode.connect();
                    if (!connectionFromPool) {
                        // Devrait être géré par poolNode.connect() qui throw une erreur
                        throw new Error(
                            "Failed to get connection from pool (returned null)"
                        );
                    }
                    this.status({
                        fill: "blue",
                        shape: "dot",
                        text: "Pool conn OK. Executing...",
                    });

                    const processedMsg = await this.executeQueryAndProcess(
                        connectionFromPool,
                        currentQueryString,
                        currentQueryParams,
                        isPreparedStatement,
                        msg
                    );
                    this.status({
                        fill: "green",
                        shape: "dot",
                        text: "success",
                    });
                    send(processedMsg);
                    if (done) done();
                    return; // Succès à la première tentative
                } catch (err) {
                    firstAttemptError = this.enhanceError(
                        err,
                        currentQueryString,
                        currentQueryParams,
                        "Query failed with pooled connection"
                    );
                    this.warn(
                        `First attempt failed: ${firstAttemptError.message}`
                    );
                    // Ne pas remonter l'erreur tout de suite, on va peut-être retenter
                } finally {
                    if (connectionFromPool) {
                        try {
                            await connectionFromPool.close(); // Toujours fermer/remettre la connexion au pool
                        } catch (closeErr) {
                            this.warn(
                                `Error closing pooled connection: ${closeErr}`
                            );
                        }
                        connectionFromPool = null;
                    }
                }

                // --- Si la première tentative a échoué (firstAttemptError est défini) ---
                if (firstAttemptError) {
                    if (
                        this.poolNode &&
                        this.poolNode.config.retryFreshConnection
                    ) {
                        this.log("Attempting retry with a fresh connection.");
                        this.status({
                            fill: "yellow",
                            shape: "dot",
                            text: "Retrying (fresh)...",
                        });

                        let freshConnection = null;
                        try {
                            // Utiliser les paramètres de connexion originaux stockés dans poolNode
                            const freshConnectConfig =
                                this.poolNode.originalConfigForFreshConnection;
                            if (
                                !freshConnectConfig ||
                                !freshConnectConfig.connectionString
                            ) {
                                throw new Error(
                                    "Fresh connection configuration is missing in poolNode."
                                );
                            }
                            freshConnection = await odbcModule.connect(
                                freshConnectConfig
                            );
                            this.log("Fresh connection established for retry.");

                            const processedFreshMsg =
                                await this.executeQueryAndProcess(
                                    freshConnection,
                                    currentQueryString,
                                    currentQueryParams,
                                    isPreparedStatement,
                                    msg
                                );

                            this.log(
                                "Query successful with fresh connection. Resetting pool."
                            );
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "Success (fresh)",
                            });
                            send(processedFreshMsg);

                            if (this.poolNode.resetPool) {
                                await this.poolNode.resetPool(); // Demander au pool de se réinitialiser
                            } else {
                                this.warn(
                                    "poolNode.resetPool is not available. Pool cannot be reset automatically."
                                );
                            }

                            if (done) done();
                            return; // Succès à la seconde tentative
                        } catch (freshError) {
                            this.warn(
                                `Retry with fresh connection also failed: ${freshError.message}`
                            );
                            // L'erreur finale sera celle de la tentative fraîche
                            throw this.enhanceError(
                                freshError,
                                currentQueryString,
                                currentQueryParams,
                                "Query failed on fresh connection retry"
                            );
                        } finally {
                            if (freshConnection) {
                                try {
                                    await freshConnection.close();
                                    this.log("Fresh connection closed.");
                                } catch (closeFreshErr) {
                                    this.warn(
                                        `Error closing fresh connection: ${closeFreshErr}`
                                    );
                                }
                            }
                        }
                    } else {
                        // retryFreshConnection n'est pas activé, donc on lance l'erreur de la première tentative
                        throw firstAttemptError;
                    }
                }
            } catch (err) {
                // Catch global pour runQuery
                // Assurer que err est bien un objet Error
                const finalError =
                    err instanceof Error ? err : new Error(String(err));

                this.status({
                    fill: "red",
                    shape: "ring",
                    text:
                        finalError.message && finalError.message.length < 30
                            ? finalError.message.substring(0, 29) + "..."
                            : "query error",
                });

                if (done) {
                    done(finalError); // Passer l'erreur au callback done de Node-RED
                } else {
                    this.error(finalError, msg); // Utiliser this.error pour logguer l'erreur correctement
                }
            }
        }; // Fin de runQuery

        this.checkPool = async function (msg, send, done) {
            try {
                if (!this.poolNode) {
                    throw new Error(
                        "ODBC Connection Configuration node is not properly configured or deployed."
                    );
                }
                if (this.poolNode.connecting) {
                    // Si le pool est en cours d'initialisation
                    this.warn("Waiting for connection pool to initialize...");
                    this.status({
                        fill: "yellow",
                        shape: "ring",
                        text: "Waiting for pool",
                    });
                    setTimeout(() => {
                        this.checkPool(msg, send, done).catch((err) => {
                            // Gérer l'erreur de la tentative retardée si elle échoue aussi.
                            this.status({
                                fill: "red",
                                shape: "dot",
                                text: "Pool wait failed",
                            });
                            if (done) {
                                done(err);
                            } else {
                                this.error(err, msg);
                            }
                        });
                    }, 1000); // Réessayer après 1 seconde
                    return;
                }

                // Si le pool n'est pas encore initialisé (ex: premier message après déploiement),
                // poolNode.connect() va le faire.
                // La logique de this.poolNode.connecting doit être gérée DANS poolNode.connect()

                await this.runQuery(msg, send, done);
            } catch (err) {
                // Catch pour checkPool (erreurs avant même d'appeler runQuery, ou erreurs non gérées par runQuery)
                const finalError =
                    err instanceof Error ? err : new Error(String(err));
                this.status({
                    fill: "red",
                    shape: "dot",
                    text:
                        finalError.message && finalError.message.length < 30
                            ? finalError.message.substring(0, 29) + "..."
                            : "Op failed",
                });
                if (done) {
                    done(finalError);
                } else {
                    this.error(finalError, msg);
                }
            }
        };

        this.on("input", async (msg, send, done) => {
            // Envelopper l'appel à checkPool dans un try-catch au cas où checkPool lui-même aurait une erreur synchrone non gérée
            try {
                await this.checkPool(msg, send, done);
            } catch (error) {
                const finalError =
                    error instanceof Error ? error : new Error(String(error));
                this.status({
                    fill: "red",
                    shape: "ring",
                    text: "Input error",
                });
                if (done) {
                    done(finalError);
                } else {
                    this.error(finalError, msg);
                }
            }
        });

        this.on("close", async (done) => {
            // La connexion individuelle (this.connection du code original) est maintenant gérée
            // à l'intérieur de runQuery (connectionFromPool et freshConnection) et fermée là.
            // Il n'y a donc plus de this.connection à fermer ici au niveau du noeud odbc.
            // Le poolNode (config node) gère la fermeture de son pool.
            this.status({}); // Clear status on close/redeploy
            done();
        });

        if (this.poolNode) {
            this.status({ fill: "green", shape: "dot", text: "ready" });
        } else {
            this.status({ fill: "red", shape: "ring", text: "No config node" });
            this.warn(
                "ODBC Config node not found or not deployed. Please configure and deploy the ODBC connection config node."
            );
        }
    }

    RED.nodes.registerType("odbc", odbc);
};
