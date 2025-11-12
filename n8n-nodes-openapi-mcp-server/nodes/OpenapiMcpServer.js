"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenapiMcpServer = void 0;
const mcp_tool_convert_1 = require("../lib/mcp_tool_convert");
let tools = []; // ✅ cache global tools
// ======================================================
// Load OpenAPI → MCP Tools
// ======================================================
async function loadTools(openapiUrl) {
    tools = await (0, mcp_tool_convert_1.getMcpTools)(openapiUrl);
}
// ======================================================
// Eksekusi Tool HTTP
// ======================================================
async function executeTool(tool, args = {}, baseUrl, token) {
    const x = tool["x-props"] || {};
    const method = (x.method || "GET").toUpperCase();
    const path = x.path || `/${tool.name}`;
    const url = `${baseUrl}${path}`;
    const opts = {
        method,
        headers: Object.assign({ "Content-Type": "application/json" }, (token ? { Authorization: `Bearer ${token}` } : {})),
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
async function handleMCPRequest(request) {
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
            const toolName = params === null || params === void 0 ? void 0 : params.name;
            const tool = tools.find((t) => t.name === toolName);
            if (!tool) {
                return {
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32601, message: `Tool '${toolName}' not found` },
                };
            }
            try {
                const baseUrl = credentials === null || credentials === void 0 ? void 0 : credentials.baseUrl;
                const token = credentials === null || credentials === void 0 ? void 0 : credentials.token;
                const result = await executeTool(tool, (params === null || params === void 0 ? void 0 : params.arguments) || {}, baseUrl, token);
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
            }
            catch (err) {
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
class OpenapiMcpServer {
    constructor() {
        this.description = {
            displayName: 'OpenAPI MCP Server',
            name: 'openapiMcpServer',
            group: ['trigger'],
            version: 1,
            description: 'Runs an MCP Server inside n8n',
            icon: 'fa:server',
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
            ],
        };
    }
    // ==================================================
    // WEBHOOK HANDLER
    // ==================================================
    async webhook() {
        const openapiUrl = this.getNodeParameter("openapiUrl", 0);
        if (!tools.length) {
            await loadTools(openapiUrl);
        }
        const creds = await this.getCredentials("openapiMcpServerCredentials");
        const body = this.getBodyData();
        if (Array.isArray(body)) {
            const responses = body.map((r) => handleMCPRequest(Object.assign(Object.assign({}, r), { credentials: creds })));
            return {
                webhookResponse: await Promise.all(responses),
            };
        }
        const single = await handleMCPRequest(Object.assign(Object.assign({}, body), { credentials: creds }));
        return {
            webhookResponse: single,
        };
    }
}
exports.OpenapiMcpServer = OpenapiMcpServer;
