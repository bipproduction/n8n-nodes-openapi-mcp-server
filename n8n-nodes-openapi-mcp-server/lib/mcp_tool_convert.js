"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertOpenApiToMcpTools = convertOpenApiToMcpTools;
exports.getMcpTools = getMcpTools;
const lodash_1 = __importDefault(require("lodash"));
/**
 * Convert OpenAPI 3.x JSON spec into MCP-compatible tool definitions (without run()).
 * Hanya menyertakan endpoint yang memiliki tag berisi "mcp".
 */
function convertOpenApiToMcpTools(openApiJson, filterTag) {
    var _a, _b, _c;
    const tools = [];
    const paths = openApiJson.paths || {};
    for (const [path, methods] of Object.entries(paths)) {
        // ✅ skip semua path internal MCP
        if (path.startsWith("/mcp"))
            continue;
        for (const [method, operation] of Object.entries(methods)) {
            const tags = Array.isArray(operation.tags) ? operation.tags : [];
            // ✅ exclude semua yang tidak punya tag atau tag-nya tidak mengandung "mcp"
            if (!tags.length || !tags.some(t => t.toLowerCase().includes(filterTag)))
                continue;
            const rawName = lodash_1.default.snakeCase(operation.operationId || `${method}_${path}`) || "unnamed_tool";
            const name = cleanToolName(rawName);
            const description = operation.description ||
                operation.summary ||
                `Execute ${method.toUpperCase()} ${path}`;
            const schema = ((_c = (_b = (_a = operation.requestBody) === null || _a === void 0 ? void 0 : _a.content) === null || _b === void 0 ? void 0 : _b["application/json"]) === null || _c === void 0 ? void 0 : _c.schema) || {
                type: "object",
                properties: {},
                additionalProperties: true,
            };
            const tool = {
                name,
                description,
                "x-props": {
                    method: method.toUpperCase(),
                    path,
                    operationId: operation.operationId,
                    tag: tags[0],
                    deprecated: operation.deprecated || false,
                    summary: operation.summary,
                },
                inputSchema: Object.assign(Object.assign({}, schema), { additionalProperties: true, $schema: "http://json-schema.org/draft-07/schema#" }),
            };
            tools.push(tool);
        }
    }
    return tools;
}
/**
 * Bersihkan nama agar valid untuk digunakan sebagai tool name
 * - hapus karakter spesial
 * - ubah slash jadi underscore
 * - hilangkan prefix umum (get_, post_, api_, dll)
 * - rapikan underscore berganda
 */
function cleanToolName(name) {
    return name
        .replace(/[{}]/g, "")
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .replace(/^(get|post|put|delete|patch|api)_/i, "")
        .replace(/^(get_|post_|put_|delete_|patch_|api_)+/gi, "")
        .replace(/(^_|_$)/g, "");
}
/**
 * Ambil OpenAPI JSON dari endpoint dan konversi ke tools MCP
 */
async function getMcpTools(url, filterTag) {
    const data = await fetch(url);
    const openApiJson = await data.json();
    const tools = convertOpenApiToMcpTools(openApiJson, filterTag);
    return tools;
}
