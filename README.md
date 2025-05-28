### `odbc config`

A configuration node that manages connections in an `odbc.pool` object. [Can take any configuration property recognized by `odbc.pool()`](https://www.npmjs.com/package/odbc#constructor-odbcpoolconnectionstring). The connection pool will initialize the first time
an `odbc` node receives an input message.

#### Properties

-   (**required**) **`connectionString`**: <`string`>

    An ODBC connection string that defines your DSN and/or connection string options.
    Check your ODBC driver documentation for more information about valid connection strings.

    Example:

    ```
    DSN=MyDSN;DFT=2;
    ```

-   (optional) **`initialSize`**: <`number`>

    The number of connections created in the pool when it is initialized. Default: 5.

-   (optional) **`incrementSize`**: <`number`>

    The number of connections that are created when the pool is exhausted. Default: 5.

-   (optional) **`maxSize`**: <`number`>

    The maximum number of connections allowed in the pool before it won't create any more. Default: 15.

-   (optional) **`shrinkPool`**: <`boolean`>

    Whether the number of connections should be reduced to `initialSize` when they are returned to the pool. Default: true.

-   (optional) **`connectionTimeout`**: <`number`>

    The number of seconds for a connection to remain idle before closing. Default: 3.

-   (optional) **`loginTimeout`**: <`number`>

    The number of seconds for an attempt to create a connection before returning to the application.
    Default: 3.

-   (optional) **`retryFreshConnection`**: <`boolean`> If checked, in case of a query error when using a pooled connection, the node will attempt the query a second time using a brand new database connection (not from the pool). If this second attempt is successful, it indicates the original pooled connection or the pool itself might be problematic. Consequently, the entire connection pool will be closed and reset, forcing a new pool to be created on subsequent requests. This can help recover from stale or broken connections within the pool. Default: false.

-   (optional) **`syntaxChecker`**: <`boolean`>

    Whether the syntax validator is activated or not. If activated, the query string will be [parsed](https://www.npmjs.com/package/node-sql-parser#create-ast-for-sql-statement) and appended as an object to the output message with a key named `parsedSql`. Default: false.

-   (optional) **`syntax`**: <`string`>

    Dropdown list of the available [SQL flavors available](https://www.npmjs.com/package/node-sql-parser#supported-database-sql-syntax). Default: mysql.
