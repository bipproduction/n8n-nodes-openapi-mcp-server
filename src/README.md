
# n8n-nodes-openapi-mcp-server

[![NPM version](https://img.shields.io/npm/v/n8n-nodes-openapi-mcp-server?style=flat-square)](https://www.npmjs.com/package/n8n-nodes-openapi-mcp-server)
[![NPM downloads](https://img.shields.io/npm/dm/n8n-nodes-openapi-mcp-server?style=flat-square)](https://www.npmjs.com/package/n8n-nodes-openapi-mcp-server)

This is an n8n node that acts as a trigger, running an MCP (Machine-readable Capability Protocol) server inside n8n. It dynamically generates tools from an OpenAPI specification URL and makes them available via a webhook.

## Installation

To install this node, follow these steps:

1.  Go to your n8n instance.
2.  Go to **Settings > Community Nodes**.
3.  Click **Install** and enter `n8n-nodes-openapi-mcp-server`.
4.  Click **Install** again.

Alternatively, you can use npm in your n8n's custom nodes directory:

```bash
npm install n8n-nodes-openapi-mcp-server
```

## Configuration

The node has the following properties:

-   **Path**: The path for the webhook URL. Defaults to `mcp`.
-   **OpenAPI URL**: The URL of the `openapi.json` file to generate tools from.
-   **Default Filter**: An optional tag to filter the tools from the OpenAPI specification.
-   **Available Tools**: A read-only list of the tools that have been successfully loaded from the OpenAPI URL. This list refreshes automatically when you open the node.

### Credentials

This node requires credentials to authenticate with the target API.

-   **Base URL**: The base URL of the API (e.g., `https://api.example.com`).
-   **Bearer Token**: The Bearer token for authentication.

## Usage

This node functions as a webhook trigger. Once activated, it will provide a webhook URL. You can send MCP requests to this URL to interact with the tools generated from the OpenAPI specification.

The node handles the following MCP methods:

-   `initialize`: Initializes the connection.
-   `tools/list`: Lists all the available tools.
-   `tools/call`: Executes a specific tool with the given arguments.
-   `ping`: A simple ping to check the connection.

When a `tools/call` request is received, the node will make an HTTP request to the corresponding API endpoint defined in the OpenAPI specification, using the provided credentials.

## Example

Here is an example of how to call the `tools/list` method using `curl`. Replace `YOUR_N8N_WEBHOOK_URL` with the actual webhook URL provided by the node.

```bash
curl -X POST YOUR_N8N_WEBHOOK_URL \
-H "Content-Type: application/json" \
-d '{
    "jsonrpc": "2.0",
    "id": "123",
    "method": "tools/list",
    "params": {}
}'
```

## Development

Contributions are welcome. Please open an issue or a pull request on the project's repository.

## License

This project is licensed under the ISC License.
