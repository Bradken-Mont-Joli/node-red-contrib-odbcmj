# Node-RED Contrib ODBC MJ

A powerful and robust Node-RED node to connect to any ODBC data source. It features connection pooling, advanced retry logic, secure credential management, dynamic query sources, and result set streaming.

This node is a fork with significant enhancements to provide stability and advanced features for enterprise use cases.

## Features

-   **Connection Pooling**: Efficiently manages database connections for high performance.
-   **Hybrid Configuration**: Configure connections using simple structured fields or a full connection string for maximum flexibility.
-   **Secure Credential Storage**: Passwords are saved using Node-RED's built-in credential system.
-   **Connection Tester**: Instantly validate your connection settings from the configuration panel.
-   **Dynamic Inputs**: Source your SQL query and parameters from message properties, flow/global context, or environment variables.
-   **Advanced Retry Logic**: Automatically handles connection errors with configurable delays and retries to ensure flow resilience.
-   **Result Streaming**: Process queries with millions of rows without exhausting memory by streaming results as chunks.
-   **Syntax Checker**: Optionally parse the SQL query to validate its structure.

---

## Nodes

### `odbc config`

A configuration node that manages the connection to your database.

#### Connection Modes

Version 2.0 introduces two ways to configure your connection:

##### 1. Structured Fields Mode (Recommended)

This is the easiest and most secure way to set up a connection for common databases.

-   **Database Type**: Select your database (e.g., SQL Server, PostgreSQL, MySQL). The node will use the appropriate driver name and connection string syntax. For unlisted databases, choose "Other" and provide the driver name manually.
-   **Server**: The hostname or IP address of the database server, optionally followed by a comma and the port number (e.g., `mydb.server.com,1433`).
-   **Database**: The name of the database to connect to (optional).
-   **User**: The username for authentication.
-   **Password**: The password for authentication. This is stored securely using Node-RED's credential system.

##### 2. Connection String Mode (Advanced)

This mode gives you full control for complex or non-standard connection strings. In this mode, you are responsible for the entire content of the string.

-   **Connection String**: Enter the complete ODBC connection string.

#### Test Connection

A **Test Connection** button in the configuration panel allows you to instantly verify your settings without deploying the flow.

#### Pool Options

-   **`initialSize`** `<number>` (optional): The number of connections to create when the pool is initialized. Default: 5.
-   **`incrementSize`** `<number>` (optional): The number of connections to create when the pool is exhausted. Default: 5.
-   **`maxSize`** `<number>` (optional): The maximum number of connections allowed in the pool. Default: 15.
-   **`shrinkPool`** `<boolean>` (optional): Whether to reduce the number of connections to `initialSize` when they are returned to the pool. Default: true.
-   **`connectionTimeout`** `<number>` (optional): The number of seconds for a connection to remain idle before closing. Default: 3.
-   **`loginTimeout`** `<number>` (optional): The number of seconds for an attempt to create a connection to succeed. Default: 3.

#### Error Handling & Retry

-   **`retryFreshConnection`** `<boolean>` (optional): If a query fails, the node will retry once with a brand new connection. If this succeeds, the entire connection pool is reset to clear any stale connections. Default: false.
-   **`retryDelay`** `<number>` (optional): If both the pooled and the fresh connection attempts fail, this sets a delay in seconds before another retry is attempted. A value of **0** disables further automatic retries. Default: 5.
-   **`retryOnMsg`** `<boolean>` (optional): If the node is waiting for a timed retry, a new incoming message can override the timer and trigger an immediate retry. Default: true.

#### Advanced

-   **`syntaxChecker`** `<boolean>` (optional): If activated, the query string will be [parsed](https://www.npmjs.com/package/node-sql-parser#create-ast-for-sql-statement) and appended as an object to the output message at `msg.parsedQuery`. Default: false.
-   **`syntax`** `<string>` (optional): The SQL flavor to use for the syntax checker. Default: mysql.

---

### `odbc`

This node executes a query against the configured database when it receives a message.

#### Properties

-   **`connection`** `<odbc config>` (**required**): The configuration node that defines the connection settings.
-   **`Query`** `<string>` (optional): A default SQL query to execute if no query is provided dynamically from an input source. Can contain Mustache syntax (e.g., `{{{payload.id}}}`).
-   **`Result to`** `<string>` (**required**): The property of the output message where the results will be stored (e.g., `payload`). Default: `payload`.

#### Dynamic Inputs

To make the node highly flexible, the SQL query and its parameters can be sourced dynamically using **Typed Inputs**.

-   **`Query Source`**: A Typed Input that specifies where to find the query string at runtime. This value **overrides** the static query defined in the editor.
    -   *Default*: `msg.query` (for backward compatibility).
    -   *Example*: Set to `flow.mySqlQuery` to read the query from a flow context variable.

-   **`Parameters Source`**: A Typed Input that specifies where to find the array or object of parameters for prepared statements.
    -   *Default*: `msg.parameters`.
    -   *Example*: Set to `msg.payload.bindings` to use the array found in that property.

#### Streaming Results

For queries that return a large number of rows, streaming prevents high memory usage.

-   **`Stream Results`** `<boolean>`: Enables or disables streaming mode. When enabled, the node will output multiple messages, one for each chunk of rows. Default: false.
-   **`Chunk Size`** `<number>`: The number of rows to include in each output message. A value of `1` means one message will be sent for every single row. Default: 1.

##### Streaming Output Format

When streaming is active, each output message will contain:
-   A payload (or the configured output property) containing an array of rows for the current chunk.
-   A `msg.odbc_stream` object with metadata for tracking progress:
    -   `index`: The starting index of the current chunk (e.g., 0, 100, 200...).
    -   `count`: The number of rows in the current chunk.
    -   `complete`: A boolean that is `true` only on the very last message, and `false` otherwise. The last payload will always be an empty array.  This is useful for triggering a downstream action once all rows have been processed.