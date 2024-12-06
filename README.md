# node-red-contrib-odbcmj

A Node-RED implementation of odbc.js (https://www.npmjs.com/package/odbc). This node allows you to make queries to a database through an ODBC connection. Parameters can be passed to the SQL query using Mustache syntax, prepared statements, or directly in the query string. 

---
## Acknowledgment

This node is an unofficial fork of node-red-contrib-odbc by Mark Irish (https://github.com/markdirish/node-red-contrib-odbc) and is vastly inspired by it. It also takes ideas from node-red-contrib-odbc2 by AIS Automation (https://github.com/AISAutomation/node-red-contrib-odbc2).

**Overall changes:**

* Can use Mustache as well as a parameter array.
* Warnings when Mustache will render an undefined variable.
* Fixes the output field option so that nested objects can be used.
* Fixes the checkbox for the pool shrink option.
* Uses ace/mode/sql for the SQL input field.
* Connection nodes can have individually defined names.
* Selectable SQL syntax checker.
* Allows parameters to be passed as an object, mapping values to named parameters in the query.
* Automatically handles prepared statements based on the query and parameters.

## Installation

This package is not available from within the Node-RED palette tool. Instead, in your Node-RED user directory (usually `~/.node-red/`), download through the `npm` utility:
    ```
    npm install node-red-contrib-odbcmj
    ```

For the `odbc` connector requirements, please see [the documentation for that package](https://www.npmjs.com/package/odbc#requirements).

## Usage

`node-red-contrib-odbcmj` provides two nodes:

* **`odbc config`**: A configuration node for defining your connection string and managing your connection   
 parameters.
* **`odbc`**: A node for running queries with or without parameters.

### `odbc config`

A configuration node that manages connections in an `odbc.pool` object. [Can take any configuration property recognized by `odbc.pool()`](https://www.npmjs.com/package/odbc#constructor-odbcpoolconnectionstring). The connection pool will initialize the first time   
 an `odbc` node receives an input message.

#### Properties

* (**required**) **`connectionString`**: <`string`>

    An ODBC connection string that defines your DSN and/or connection string options.   
 Check your ODBC driver documentation for more information about valid connection strings.

    Example:
    ```
    DSN=MyDSN;DFT=2;
    ```

* (optional) **`initialSize`**: <`number`>

    The number of connections created in the pool when it is initialized. Default: 5.

* (optional) **`incrementSize`**: <`number`>

    The number of connections that are created when the pool is exhausted. Default: 5.

* (optional) **`maxSize`**: <`number`>

    The maximum number of connections allowed in the pool before it won't create any more. Default: 15.

* (optional) **`shrinkPool`**: <`boolean`>

    Whether the number of connections should be reduced to `initialSize` when they are returned to the pool. Default: true.

* (optional) **`connectionTimeout`**: <`number`>

    The number of seconds for a connection to remain idle before closing. Default: 3.

* (optional) **`loginTimeout`**: <`number`>

    The number of seconds for an attempt to create a connection before returning to the application.   
 Default: 3.

* (optional) **`syntaxChecker`**: <`boolean`>

    Whether the syntax validator is activated or not. If activated, the query string will be [parsed](https://www.npmjs.com/package/node-sql-parser#create-ast-for-sql-statement) and appended as an object to the output message with a key named `parsedSql`. Default: false.

* (optional) **`syntax`**: <`string`>

    Dropdown list of the available [SQL flavors available](https://www.npmjs.com/package/node-sql-parser#supported-database-sql-syntax). Default: mysql.


### `odbc`

A node that runs a query when input is received. Each instance of the node can define its own query string, as well as take a query and/or parameters as input. A query sent as an input message will override any query defined in the node properties.

#### Properties

* (**required**) **`connection`**: <`odbc config`>

    The ODBC pool node that defines the connection settings and manages the connection pool used by this node.

* (optional) **`query`**: <`string`>

    A valid SQL query string.   
 
    * Can contain parameters inserted using Mustache syntax (e.g., `{{{payload}}}`).
    * Can use placeholders (`?`) for parameters.
    * Can embed parameters directly in the query string.

* (**required**) **`result to`**: <`dot-notation string`>

    The JSON nested element structure that will contain the result output. The string must be a valid JSON object structure using dot-notation, minus the `msg.` (e.g., `payload.results`) and must not start or end with a period. Square bracket notation is not allowed. The node input object is carried out to the output, as long as the output object name does not conflict with it. If the targeted output JSON object was already present in the input, the result from the query will be appended to it   
 if it was itself an object (but not an array); otherwise, the original key/value pair will be overwritten.

    Example:

    * `input msg: {"payload": {"result": {"othervalue": 10} } };`
    * `result to: payload.results.values`

    In this case, `values` will be appended to `result` without overwriting `othervalue`. If `result` had been a string, then it would have been replaced by `values`.

#### Inputs

The `odbc` node accepts a message input that can contain:

* **`query`**: <`string`> A valid SQL query string. This overrides the query defined in the node properties.
* **`payload`**:  
    *  A JSON string containing a `query` property with the SQL string.
    *  An object with a `query` property containing the SQL string.
* **`parameters`**: <`array` or `object`>
    *  Can be an array of values or an object mapping parameter names to values.
    *  If the query contains placeholders (`?`) and `msg.parameters` is an object, the values will be automatically mapped to the placeholders based on the order of the parameters in the query.

#### Outputs

Returns a message containing:

* **`output object`**: <`array`> The `odbc` result array returned from the query.
* **`odbc`**: <`object`> Contains additional information returned by the `odbc` module.
* **`parsedQuery`**: <`object`> (Optional) The parsed SQL query if the syntax checker is enabled.

**Automatic Prepared Statement Handling**

The node automatically determines whether to use a prepared statement or a regular query based on the following:

* **Presence of Placeholders:** If the query string contains placeholders (`?`), the node will use a prepared statement.
* **`msg.parameters` Object:** If the `msg.parameters` object is provided (either as an array or an object), the node will use a prepared statement.

This automatic handling ensures that your queries are executed in the most secure way possible, minimizing the risk of SQL injection vulnerabilities.