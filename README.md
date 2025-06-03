# Node-RED Contrib ODBC MJ

A powerful and robust Node-RED node to connect to any ODBC data source. It features connection pooling, advanced retry logic, secure credential management, dynamic query sources, result set streaming, and configurable timeouts.

This node is a fork with significant enhancements to provide stability and advanced features for enterprise use cases.

## Features

-   **Connection Pooling**: Efficiently manages database connections for high performance.
-   **Hybrid Configuration**: Configure connections using simple structured fields or a full connection string for maximum flexibility.
-   **Secure Credential Storage**: Passwords are saved using Node-RED's built-in credential system.
-   **Connection Tester**: Instantly validate your connection settings from the configuration panel.
-   **Dynamic Inputs**: Source your SQL query and parameters from message properties, flow/global context, or environment variables.
-   **Intelligent Error Handling & Retry Logic**: Differentiates between SQL errors and actual connection problems. Automatically handles connection errors with configurable delays and retries to ensure flow resilience.
-   **Result Streaming**: Process queries with millions of rows without exhausting memory by streaming results as chunks, with a clear completion signal.
-   **Configurable Timeouts**: Set timeouts for login, query execution, and internal close operations to prevent hangs.
-   **Optional Fast Shutdown**: Provides a "fire-and-forget" option for pool closing to handle problematic drivers during Node-RED shutdown/deploy.
-   **Syntax Checker**: Optionally parse the SQL query to validate its structure.

---

## Nodes

### `odbc config`

A configuration node that manages the connection to your database.

#### Connection Modes

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
> **Note:** For security reasons, passwords are not reloaded into the editor. If your connection requires a password, you must **re-enter it** in the password field before clicking the test button (in Structured Mode). For Connection String mode, ensure the full string (including password if needed) is present in the connection string field itself.

#### Pool & Connection Options

-   **`Initial Pool Size`** `<number>` (optional): The number of connections to create when the pool is initialized. Default: 5.
-   **`Increment Pool Size`** `<number>` (optional): The number of connections to create when the pool is exhausted. Default: 5.
-   **`Max Pool Size`** `<number>` (optional): The maximum number of connections allowed in the pool. Default: 15.
-   **`Shrink Pool`** `<boolean>` (optional): If checked, reduces the number of connections to `Initial Pool Size` when they are returned to the pool if the pool has grown. Default: true.
-   **`Idle Timeout`** `<number>` (optional): The number of seconds for a connection in the pool to remain idle before closing. Default: 3 seconds. (Refers to the `connectionTimeout` property of the `odbc` library's pool options, converted to seconds).
-   **`Login Timeout`** `<number>` (optional): The number of seconds for an attempt to establish a new connection to succeed. Default: 5 seconds.
-   **`Query Timeout`** `<number>` (optional): The number of seconds for a query to execute before timing out. A value of **0** means infinite or uses the driver/database default. Default: 0 seconds.

#### Error Handling & Retry

The node attempts to distinguish between errors related to the SQL query itself (syntax, permissions) and actual connection problems. Connection retry mechanisms are primarily invoked for suspected connection issues.

-   **`Retry with fresh connection`** `<boolean>` (optional): If a query fails and a basic connectivity test (e.g., `SELECT 1`) also suggests a problem with the current pooled connection, the node will try once more with a brand new, direct connection. If this second attempt (including its own successful basic connectivity test followed by the user's query) succeeds, the entire connection pool is reset to clear any potentially stale connections. Default: false.
-   **`Retry Delay`** `<number>` (optional): If all immediate attempts fail and the problem is diagnosed as a *connection issue* (e.g., the `SELECT 1` test fails on both pooled and fresh connections), this sets a delay in seconds before another attempt to process the incoming message is made (using the pool again). A value of **0** disables this timed retry mechanism for connection issues. Default: 5.
-   **`Retry on new message`** `<boolean>` (optional): If the node is waiting for a timed retry (due to `Retry Delay` for a connection issue), a new incoming message can, if this is checked, override the timer and trigger an immediate retry of the *original* message that failed. Default: true.

#### Shutdown Options

-   **`Fast close (Fire-and-forget)`** `<boolean>` (optional):
    -   **Warning:** When checked, Node-RED will not wait for the connection pool to properly close during a deploy or shutdown.
    -   This option can prevent Node-RED from hanging if specific ODBC drivers have issues closing connections quickly.
    -   However, enabling this may result in orphaned connections on the database server, potentially consuming server resources.
    -   It is recommended to leave this unchecked unless you are experiencing hangs during Node-RED deploys or shutdowns related to this config node. Default: false.

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

-   **`Stream Results`** `<boolean>`: Enables or disables streaming mode. When enabled, the node will output multiple messages. Default: false.
-   **`Chunk Size`** `<number>`: When streaming, this is the number of rows to include in each data message. A value of `1` means one message will be sent for every single row. Default: 1.

##### Streaming Output Format

When streaming is active, the node sends messages in sequence:

1.  **Data Messages**: One or more messages where the payload (or the configured output property) contains an array of rows for the current chunk. For these messages, `msg.odbc_stream.complete` will be **`false`**.
2.  **Completion Message**: A single, final message indicating the end of the stream. For this message:
    -   The payload (or configured output property) will be an **empty array `[]`**.
    -   `msg.odbc_stream.complete` will be **`true`**.

The `msg.odbc_stream` object contains metadata for tracking:
-   `index`: The starting index of the current chunk (0-based). For the completion message, this will be the total number of data rows processed.
-   `count`: The number of rows in the current chunk. This will be `0` for the completion message.
-   `complete`: The boolean flag (`true`/`false`).

This pattern ensures you can reliably trigger a final action (like closing a file or calculating an aggregate) only when the message with `complete: true` is received.