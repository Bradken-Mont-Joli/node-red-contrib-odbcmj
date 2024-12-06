module.exports = function(RED) {
    const odbcModule = require('odbc'); // Import the odbc module for database connectivity
    const mustache = require('mustache'); // Import the mustache module for templating
    const objPath = require('object-path'); // Import the object-path module for object manipulation

    // --- ODBC Configuration Node ---
    function poolConfig(config) {
        RED.nodes.createNode(this, config); // Create a Node-RED node
        this.config = config; // Store the node configuration
        this.pool = null; // Initialize the connection pool
        this.connecting = false; // Flag to indicate if the node is connecting

        const enableSyntaxChecker = this.config.syntaxtick; // Renamed for clarity
        const syntax = this.config.syntax;
        delete this.config.syntaxtick;
        delete this.config.syntax;

        // Create a SQL parser if syntax check is enabled
        this.parser = enableSyntaxChecker 
            ? new require('node-sql-parser/build/' + syntax).Parser() 
            : null;

        // Convert numeric config params to integers
        for (const [key, value] of Object.entries(this.config)) {
            if (!isNaN(parseInt(value))) {
                this.config[key] = parseInt(value);
            }
        }

        // Connect to the database and create a connection pool
        this.connect = async () => {
            if (!this.pool) {
                try {
                    this.pool = await odbcModule.pool(this.config);
                    this.connecting = false;
                } catch (error) {
                    // Handle connection errors (e.g., log the error, set node status)
                    this.error(`Error creating connection pool: ${error}`);
                    this.status({ fill: "red", shape: "ring", text: "Connection error" });
                    throw error; // Re-throw to prevent further execution
                }
            }
            return await this.pool.connect();
        };

        // Close the connection pool when the node is closed
        this.on('close', async (removed, done) => {
            if (removed && this.pool) {
                try {
                    await this.pool.close();
                } catch (error) {
                    // Handle errors during pool closure
                    this.error(`Error closing connection pool: ${error}`);
                }
            }
            done();
        });
    }

    RED.nodes.registerType('odbc config', poolConfig);

    // --- ODBC Query Node ---
    function odbc(config) {
        RED.nodes.createNode(this, config);
        this.config = config;
        this.poolNode = RED.nodes.getNode(this.config.connection);
        this.name = this.config.name;

        this.runQuery = async function(msg, send, done) {
            try {
                this.status({ fill: "blue", shape: "dot", text: "querying..." });
                this.config.outputObj = msg?.output || this.config?.outputObj;

                // Automatically determine if it's a prepared statement based on the presence of 
                // placeholders (?) in the query or if msg.parameters is an object/array.
                const isPreparedStatement = msg?.parameters || this.queryString.includes('?'); 
                this.queryString = this.config.query;
                if (!this.queryString.length) { 
                    this.queryString = null; 
                }

                // --- Construct the query string ---
                if (!isPreparedStatement && this.queryString) {
                    // Handle Mustache templating for regular queries
                    for (const parsed of mustache.parse(this.queryString)) {
                        if (parsed[0] === "name" || parsed[0] === "&") {
                            if (!objPath.has(msg, parsed[1])) {
                                this.warn(`Mustache parameter "${parsed[1]}" is absent and will render to undefined`);
                            }
                        }
                    }
                    this.queryString = mustache.render(this.queryString, msg);
                }

                // Handle cases where the query is provided in the message
                if (msg?.query) {
                    if (this.queryString) {
                        node.log('Warning. The query defined in the node configuration was overwritten by msg.config.');
                    }
                    this.queryString = msg.query;
                } else if (msg?.payload) {
                    if (typeof msg.payload === 'string') {
                        try {
                            const payloadJson = JSON.parse(msg.payload);
                            if (payloadJson?.query && typeof payloadJson.query === 'string') {
                                this.queryString = payloadJson.query;
                            }
                        } catch (err) {} // Ignore JSON parsing errors
                    } else if (msg.payload?.query && typeof msg.payload.query === 'string') {
                        this.queryString = msg.payload.query;
                    }
                }

                if (!this.queryString) {
                    throw new Error("No query to execute");
                }

                // --- Parameter handling for prepared statements ---
                if (isPreparedStatement) { 
                    if (!msg?.parameters) {
                        throw new Error("Prepared statement requires msg.parameters");
                    } else {
                        // If parameters are provided as an object, extract parameter names from the query
                        // and create an ordered array of values for the prepared statement.
                        if (typeof msg.parameters === 'object' && !Array.isArray(msg.parameters)) {                            
                            const paramNames = this.queryString.match(/\(([^)]*)\)/)[1].split(',').map(el => el.trim()); 

                            // Create an ordered array of values
                            msg.parameters = paramNames.map(name => msg.parameters[name]);
                        }
                    }

                    // Validate the parameters array
                    if (!Array.isArray(msg.parameters)) {
                        throw new Error("msg.parameters must be an object or an array");
                    } else if ((this.queryString.match(/\?/g) || []).length !== msg.parameters.length) {
                        throw new Error("Incorrect number of parameters");
                    }                    
                }

                // --- Syntax check ---
                if (this.poolNode?.parser) {
                    try {
                        this.parseSql = this.poolNode.parser.astify(structuredClone(this.queryString));
                    } catch (error) {
                        throw new Error("SQL syntax error"); 
                    }
                }

                // --- Output object validation ---
                if (!this.config.outputObj) {
                    throw new Error("Invalid output object definition");
                }

                const reg = new RegExp('^((?![,;:`\\[\\]{}+=()!"$%?&*|<>\\/^¨`\\s]).)*$');
                if (!this.config.outputObj.match(reg) ||
                    this.config.outputObj.charAt(0) === "." ||
                    this.config.outputObj.charAt(this.config.outputObj.length - 1) === ".") {
                    throw new Error("Invalid output field");
                }

                // --- Get a connection from the pool ---
                try {
                    this.connection = await this.poolNode.connect();
                    if (!this.connection) {
                        throw new Error("No connection available");
                    }
                } catch (error) {
                    // Handle connection errors (e.g., log the error, set node status)
                    this.error(`Error getting connection: ${error}`);
                    this.status({ fill: "red", shape: "ring", text: "Connection error" });
                    throw error; // Re-throw to prevent further execution
                }

                try {
                    let result;
                    if (isPreparedStatement) {
                        // --- Execute prepared statement ---
                        const stmt = await this.connection.createStatement();
                        await this.connection.prepare(this.queryString);
                        let values = msg.parameters; 

                        // Bind the values to the prepared statement
                        await stmt.bind(values);

                        // Execute the prepared statement
                        result = await stmt.execute();
                        stmt.close(); 
                    } else {
                        // --- Execute regular query ---
                        result = await this.connection.query(this.queryString, msg?.parameters);
                    }

                    if (result) {
                        // --- Process and send the result ---
                        const otherParams = {};
                        for (const [key, value] of Object.entries(result)) {
                            if (isNaN(parseInt(key))) {
                                otherParams[key] = value;
                                delete result[key];
                            }
                        }
                        objPath.set(msg, this.config.outputObj, result);
                        if (this.parseSql) {
                            msg.parsedQuery = this.parseSql;
                        }
                        if (Object.keys(otherParams).length) {
                            msg.odbc = otherParams;
                        }
                        this.status({ fill: 'green', shape: 'dot', text: 'success' });
                        send(msg);
                    } else {
                        throw new Error("The query returned no results");
                    }
                } catch (error) {
                    // Handle query errors (e.g., log the error, set node status)
                    this.error(`Error executing query: ${error}`);
                    this.status({ fill: "red", shape: "ring", text: "Query error" });
                    throw error; // Re-throw to trigger the outer catch block
                } finally {
                    await this.connection.close();
                }

                if (done) {
                    done();
                }
            } catch (err) {
                this.status({ fill: "red", shape: "ring", text: err.message || "query error" });
                if (done) {
                    done(err);
                } else {
                    this.error(err, msg);
                }
            }
        };

        // --- Check connection pool before running query ---
        this.checkPool = async function(msg, send, done) {
            try {
                if (this.poolNode.connecting) {
                    this.warn("Waiting for connection pool...");
                    this.status({ fill: "yellow", shape: "ring", text: "requesting pool" });
                    setTimeout(() => {
                        this.checkPool(msg, send, done);
                    }, 1000);
                    return;
                }

                if (!this.poolNode.pool) {
                    this.poolNode.connecting = true;
                }

                await this.runQuery(msg, send, done);
            } catch (err) {
                this.status({ fill: "red", shape: "dot", text: "operation failed" });
                if (done) {
                    done(err);
                } else {
                    this.error(err, msg);
                }
            }
        };

        this.on('input', this.checkPool);

        // --- Close the connection when the node is closed ---
        this.on('close', async (done) => {
            if (this.connection) {
                try {
                    await this.connection.close();
                } catch (error) {
                    // Handle connection close errors
                    this.error(`Error closing connection: ${error}`);
                }
            }
            done();
        });

        this.status({ fill: 'green', shape: 'dot', text: 'ready' });
    }

    RED.nodes.registerType("odbc", odbc);
};