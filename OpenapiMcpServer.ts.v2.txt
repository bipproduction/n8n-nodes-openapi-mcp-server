import {
    INodeType,
    INodeTypeDescription,
    IWebhookFunctions,
    IWebhookResponseData,
    ILoadOptionsFunctions,
    INodePropertyOptions,
} from 'n8n-workflow';
import { getMcpTools } from "../lib/mcp_tool_convert";

// ======================================================
// Cache tools per URL
// ======================================================
const toolsCache = new Map<string, any[]>();

// ======================================================
// Load OpenAPI → MCP Tools
// ======================================================
async function loadTools(openapiUrl: string, filterTag: string, forceRefresh = false): Promise<any[]> {
    const cacheKey = `${openapiUrl}::${filterTag}`;

    if (!forceRefresh && toolsCache.has(cacheKey)) {
        return toolsCache.get(cacheKey)!;
    }

    console.log(`[MCP] 🔄 Refreshing tools from ${openapiUrl} ...`);
    const fetched = await getMcpTools(openapiUrl, filterTag);

    console.log(`[MCP] ✅ Loaded ${fetched.length} tools`);
    if (fetched.length > 0) {
        console.log(`[MCP] Tools: ${fetched.map((t: any) => t.name).join(", ")}`);
    }

    toolsCache.set(cacheKey, fetched);
    return fetched;
}

// ======================================================
// JSON-RPC Types
// ======================================================
type JSONRPCRequest = {
    jsonrpc: "2.0";
    id: string | number;
    method: string;
    params?: any;
    credentials?: any;
};

type JSONRPCResponse = {
    jsonrpc: "2.0";
    id: string | number;
    result?: any;
    error?: { code: number; message: string; data?: any };
};

// ======================================================
// EXECUTE TOOL — SUPPORT PATH, QUERY, HEADER, BODY, COOKIE
// ======================================================
async function executeTool(
    tool: any,
    args: Record<string, any> = {},
    baseUrl: string,
    token?: string
) {
    const x = tool["x-props"] || {};
    const method = (x.method || "GET").toUpperCase();
    let path = x.path || `/${tool.name}`;

    const query: Record<string, any> = {};
    const headers: Record<string, any> = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    let bodyPayload: any = undefined;

    // ======================================================
    // Pisahkan args berdasarkan OpenAPI parameter location
    // ======================================================
    if (Array.isArray(x.parameters)) {
        for (const p of x.parameters) {
            const name = p.name;
            const value = args[name];
            if (value === undefined) continue;

            switch (p.in) {
                case "path":
                    path = path.replace(`{${name}}`, encodeURIComponent(value));
                    break;

                case "query":
                    query[name] = value;
                    break;

                case "header":
                    headers[name] = value;
                    break;

                case "cookie":
                    headers["Cookie"] = `${name}=${value}`;
                    break;

                case "body":
                case "requestBody":
                    bodyPayload = value;
                    break;

                default:
                    break;
            }
        }
    } else {
        // fallback → semua args dianggap body
        bodyPayload = args;
    }

    // ======================================================
    // Build Final URL
    // ======================================================
    let url = `${baseUrl}${path}`;
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;

    // ======================================================
    // Build Request Options
    // ======================================================
    const opts: RequestInit = { method, headers };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && bodyPayload !== undefined) {
        opts.body = JSON.stringify(bodyPayload);
    }

    console.log(`[MCP] → Calling ${method} ${url}`);

    const res = await fetch(url, opts);
    const contentType = res.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
        ? await res.json()
        : await res.text();

    return {
        success: res.ok,
        status: res.status,
        method,
        url,
        path,
        data,
    };
}

// ======================================================
// JSON-RPC Handler
// ======================================================
async function handleMCPRequest(
    request: JSONRPCRequest,
    tools: any[]
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
                    tools: tools.map((t) => {
                        const inputSchema =
                            typeof t.inputSchema === "object" && t.inputSchema?.type === "object"
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
            const toolName = params?.name;
            const tool = tools.find((t) => t.name === toolName);

            if (!tool) {
                return {
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32601, message: `Tool '${toolName}' not found` },
                };
            }

            // Converter MCP content yang valid
            function convertToMcpContent(data: any) {
                // Jika string → text
                if (typeof data === "string") {
                    return {
                        type: "text",
                        text: data,
                    };
                }

                // Jika kirim tipe khusus image
                if (data?.__mcp_type === "image") {
                    return {
                        type: "image",
                        data: data.base64,
                        mimeType: data.mimeType || "image/png",
                    };
                }

                // Jika audio
                if (data?.__mcp_type === "audio") {
                    return {
                        type: "audio",
                        data: data.base64,
                        mimeType: data.mimeType || "audio/mpeg",
                    };
                }

                // Jika resource link
                if (data?.__mcp_type === "resource_link") {
                    return {
                        type: "resource_link",
                        name: data.name || "resource",
                        uri: data.uri,
                    };
                }

                // Jika object biasa → jadikan resource
                if (typeof data === "object") {
                    return {
                        type: "resource",
                        resource: data,
                    };
                }

                // fallback → text stringified
                return {
                    type: "text",
                    text: JSON.stringify(data, null, 2),
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

                const raw = result.data?.data ?? result.data;

                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [convertToMcpContent(raw)],
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
// MCP TRIGGER NODE
// ======================================================
export class OpenapiMcpServer implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'OpenAPI MCP Server',
        name: 'openapiMcpServer',
        group: ['trigger'],
        version: 1,
        description: 'Runs an MCP Server inside n8n',
        icon: 'file:icon.svg',
        defaults: { name: 'OpenAPI MCP Server' },
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
            {
                displayName: 'Available Tools (auto-refresh)',
                name: 'toolList',
                type: 'options',
                typeOptions: {
                    loadOptionsMethod: 'refreshToolList',
                    refreshOnOpen: true,
                },
                default: 'all',
                description: 'Daftar tools yang berhasil dimuat dari OpenAPI',
            },
        ],
    };

    // ==================================================
    // LoadOptions
    // ==================================================
    methods = {
        loadOptions: {
            async refreshToolList(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
                const openapiUrl = this.getNodeParameter("openapiUrl", 0) as string;
                const filterTag = this.getNodeParameter("defaultFilter", 0) as string;

                if (!openapiUrl) {
                    return [{ name: "❌ No OpenAPI URL provided", value: "" }];
                }

                const tools = await loadTools(openapiUrl, filterTag, true);

                return [
                    { name: "All Tools", value: "all" },
                    ...tools.map((t) => ({
                        name: t.name,
                        value: t.name,
                        description: t.description,
                    })),
                ];
            },
        },
    };

    // ==================================================
    // Webhook Handler
    // ==================================================
    async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
        const openapiUrl = this.getNodeParameter("openapiUrl", 0) as string;
        const filterTag = this.getNodeParameter("defaultFilter", 0) as string;

        const tools = await loadTools(openapiUrl, filterTag, true);

        const creds = await this.getCredentials("openapiMcpServerCredentials") as {
            baseUrl: string;
            token: string;
        };

        const body = this.getBodyData();

        if (Array.isArray(body)) {
            const responses = body.map((r) =>
                handleMCPRequest({ ...r, credentials: creds }, tools)
            );
            return {
                webhookResponse: await Promise.all(responses),
            };
        }

        const single = await handleMCPRequest(
            { ...(body as JSONRPCRequest), credentials: creds },
            tools
        );

        return {
            webhookResponse: single,
        };
    }
}
