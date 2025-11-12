import {
    INodeType,
    INodeTypeDescription,
    IWebhookFunctions,
    IWebhookResponseData,
} from 'n8n-workflow';

import { getMcpTools } from "../lib/mcp_tool_convert";

let tools: any[] = []; // ✅ cache global tools

// ======================================================
// Load OpenAPI → MCP Tools
// ======================================================
async function loadTools(openapiUrl: string, filterTag: string) {
    tools = await getMcpTools(openapiUrl, filterTag);
}

// ======================================================
// JSON-RPC Types
// ======================================================
type JSONRPCRequest = {
    jsonrpc: "2.0";
    id: string | number;
    method: string;
    params?: any;
    credentials?: any; // ✅ tambahan (inject credential)
};

type JSONRPCResponse = {
    jsonrpc: "2.0";
    id: string | number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
};

// ======================================================
// Eksekusi Tool HTTP
// ======================================================
async function executeTool(
    tool: any,
    args: Record<string, any> = {},
    baseUrl: string,
    token?: string
) {
    const x = tool["x-props"] || {};
    const method = (x.method || "GET").toUpperCase();
    const path = x.path || `/${tool.name}`;
    const url = `${baseUrl}${path}`;

    const opts: RequestInit = {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    };

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        opts.body = JSON.stringify(args || {});
    }

    const res = await fetch(url, opts);
    const contentType = res.headers.get("content-type") || "";

    const data = contentType.includes("application/json")
        ? await res.json()
        : await res.text();

    return {
        success: res.ok,
        status: res.status,
        method,
        path,
        data,
    };
}

// ======================================================
// JSON-RPC Handler
// ======================================================
async function handleMCPRequest(
    request: JSONRPCRequest
): Promise<JSONRPCResponse> {
    const { id, method, params, credentials } = request;

    switch (method) {
        case "initialize":
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "n8n-mcp-server", version: "1.0.0" },
                },
            };

        case "tools/list":
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    tools: tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                        "x-props": t["x-props"],
                    })),
                },
            };

        case "tools/call": {
            const toolName = params?.name;
            const tool = tools.find((t) => t.name === toolName);

            if (!tool) {
                return {
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32601, message: `Tool '${toolName}' not found` },
                };
            }

            try {
                const baseUrl = credentials?.baseUrl;
                const token = credentials?.token;

                const result = await executeTool(
                    tool,
                    params?.arguments || {},
                    baseUrl,
                    token
                );

                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                    },
                };
            } catch (err: any) {
                return {
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32603, message: err.message },
                };
            }
        }

        case "ping":
            return { jsonrpc: "2.0", id, result: {} };

        default:
            return {
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Method '${method}' not found` },
            };
    }
}

// ======================================================
// NODE MCP TRIGGER
// ======================================================
export class OpenapiMcpServer implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'OpenAPI MCP Server',
        name: 'openapiMcpServer',
        group: ['trigger'],
        version: 1,
        description: 'Runs an MCP Server inside n8n',
        icon: 'file:icon.svg',
        defaults: {
            name: 'OpenAPI MCP Server'
        },

        credentials: [
            {
                name: "openapiMcpServerCredentials",
                required: true,
            },
        ],

        inputs: [],
        outputs: ['main'],

        webhooks: [
            {
                name: 'default',
                httpMethod: 'POST',
                responseMode: 'onReceived',
                path: '={{$parameter["path"]}}',
            },
        ],

        properties: [
            {
                displayName: "Path",
                name: "path",
                type: "string",
                default: "mcp",
            },
            {
                displayName: "OpenAPI URL",
                name: "openapiUrl",
                type: "string",
                default: "",
                placeholder: "https://example.com/openapi.json",
            },
            {
                displayName: "Default Filter",
                name: "defaultFilter",
                type: "string",
                default: "",
                placeholder: "mcp | tag",
            }
        ],
    };

    // ==================================================
    // WEBHOOK HANDLER
    // ==================================================
    async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
        const openapiUrl = this.getNodeParameter("openapiUrl", 0) as string;
        const filterTag = this.getNodeParameter("defaultFilter", 0) as string;

        if (!tools.length) {
            await loadTools(openapiUrl, filterTag);
        }

        const creds = await this.getCredentials("openapiMcpServerCredentials") as {
            baseUrl: string;
            token: string;
        };

        const body = this.getBodyData();

        if (Array.isArray(body)) {
            const responses = body.map((r) =>
                handleMCPRequest({ ...r, credentials: creds })
            );
            return {
                webhookResponse: await Promise.all(responses),
            };
        }

        const single = await handleMCPRequest({
            ...(body as JSONRPCRequest),
            credentials: creds,
        });

        return {
            webhookResponse: single,
        };
    }
}
