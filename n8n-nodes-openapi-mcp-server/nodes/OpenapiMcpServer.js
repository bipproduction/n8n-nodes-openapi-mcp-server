"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenapiMcpServer = void 0;
const mcp_tool_convert_1 = require("../lib/mcp_tool_convert");
// ======================================================
// Cache tools per URL
// ======================================================
const toolsCache = new Map();
// ======================================================
// Load OpenAPI → MCP Tools
// ======================================================
async function loadTools(openapiUrl, filterTag, forceRefresh = false) {
    const cacheKey = `${openapiUrl}::${filterTag}`;
    // Jika tidak forceRefresh, gunakan cache
    if (!forceRefresh && toolsCache.has(cacheKey)) {
        return toolsCache.get(cacheKey);
    }
    console.log(`[MCP] 🔄 Refreshing tools from ${openapiUrl} ...`);
    const fetched = await (0, mcp_tool_convert_1.getMcpTools)(openapiUrl, filterTag);
    // 🟢 Log jumlah & daftar tools
    console.log(`[MCP] ✅ Loaded ${fetched.length} tools`);
    if (fetched.length > 0) {
        console.log(`[MCP] Tools: ${fetched.map((t) => t.name).join(", ")}`);
    }
    toolsCache.set(cacheKey, fetched);
    return fetched;
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
// JSON-RPC Handler (per node, per request)
// ======================================================
async function handleMCPRequest(request, tools) {
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
                    tools: tools.map((t) => {
                        var _a;
                        const inputSchema = typeof t.inputSchema === "object" && ((_a = t.inputSchema) === null || _a === void 0 ? void 0 : _a.type) === "object"
                            ? t.inputSchema
                            : {
                                type: "object",
                                properties: {},
                                required: [],
                            };
                        return {
                            name: t.name,
                            description: t.description || "No description provided",
                            inputSchema,
                            "x-props": t["x-props"],
                        };
                    }),
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
            icon: 'file:icon.svg',
            defaults: {
                name: 'OpenAPI MCP Server'
            },
            credentials: [
                { name: "openapiMcpServerCredentials", required: true },
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
                },
                // 🟢 Tambahan agar terlihat jumlah tools di UI
                {
                    displayName: 'Available Tools (auto-refresh)',
                    name: 'toolList',
                    type: 'options',
                    typeOptions: {
                        loadOptionsMethod: 'refreshToolList',
                        refreshOnOpen: true, // setiap node dibuka auto refresh
                    },
                    default: '',
                    description: 'Daftar tools yang berhasil dimuat dari OpenAPI',
                },
            ],
        };
        // ==================================================
        // LoadOptions untuk tampil di dropdown
        // ==================================================
        this.methods = {
            loadOptions: {
                // 🟢 otomatis refetch setiap kali node dibuka
                async refreshToolList() {
                    const openapiUrl = this.getNodeParameter("openapiUrl", 0);
                    const filterTag = this.getNodeParameter("defaultFilter", 0);
                    if (!openapiUrl) {
                        return [{ name: "❌ No OpenAPI URL provided", value: "" }];
                    }
                    const tools = await loadTools(openapiUrl, filterTag, true); // force refresh
                    return tools.map((t) => ({
                        name: t.name,
                        value: t.name,
                        description: t.description,
                    }));
                },
            },
        };
    }
    // ==================================================
    // WEBHOOK HANDLER
    // ==================================================
    async webhook() {
        const openapiUrl = this.getNodeParameter("openapiUrl", 0);
        const filterTag = this.getNodeParameter("defaultFilter", 0);
        // 🟢 selalu refresh (agar node terbaru)
        const tools = await loadTools(openapiUrl, filterTag, true);
        const creds = await this.getCredentials("openapiMcpServerCredentials");
        const body = this.getBodyData();
        if (Array.isArray(body)) {
            const responses = body.map((r) => handleMCPRequest(Object.assign(Object.assign({}, r), { credentials: creds }), tools));
            return {
                webhookResponse: await Promise.all(responses),
            };
        }
        const single = await handleMCPRequest(Object.assign(Object.assign({}, body), { credentials: creds }), tools);
        return {
            webhookResponse: single,
        };
    }
}
exports.OpenapiMcpServer = OpenapiMcpServer;
