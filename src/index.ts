import { getTranscript } from './tools/transcript';

export interface Env {
  TRANSCRIPT_CACHE: KVNamespace;
}

// Simple MCP server implementation for Cloudflare Workers
class SimpleMCPServer {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async handleRequest(request: any) {
    const { method, params, id } = request;

    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: 'youtube-transcript-remote',
                version: '1.0.0'
              }
            }
          };

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: [{
                name: 'get_transcript',
                description: 'Extract transcript from YouTube video URL',
                inputSchema: {
                  type: 'object',
                  properties: {
                    url: {
                      type: 'string',
                      description: 'YouTube video URL (any format)'
                    },
                    language: {
                      type: 'string',
                      description: "Optional language code for the transcript (e.g., 'en', 'es'). Defaults to 'en'."
                    }
                  },
                  required: ['url']
                }
              }]
            }
          };

        case 'tools/call':
          const { name, arguments: args } = params;

          if (name === 'get_transcript') {
            try {
              const { url, language = 'en' } = args;
              const transcript = await getTranscript(url, this.env, language);

              return {
                jsonrpc: '2.0',
                id,
                result: {
                  content: [{
                    type: 'text',
                    text: transcript
                  }]
                }
              };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

              return {
                jsonrpc: '2.0',
                id,
                error: {
                  code: -1,
                  message: errorMessage
                }
              };
            }
          } else {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32601,
                message: `Unknown tool: ${name}`
              }
            };
          }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`
            }
          };
      }
    } catch (error) {
      console.error('Error handling request:', error);
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal error'
        }
      };
    }
  }
}

// Export default object for ES Module format
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Accept",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const mcpServer = new SimpleMCPServer(env);

    // Handle SSE endpoint for MCP
    if (url.pathname === "/sse") {
      // Check if this is a POST request with JSON-RPC data
      if (request.method === "POST") {
        try {
          const requestData = await request.json();
          const response = await mcpServer.handleRequest(requestData);

          // Return as SSE format
          const sseData = `data: ${JSON.stringify(response)}\n\n`;

          return new Response(sseData, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Accept",
            }
          });
        } catch (error) {
          console.error('SSE POST error:', error);
          const errorResponse = `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32603,
              message: "Internal error"
            }
          })}\n\n`;

          return new Response(errorResponse, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
      }

      // Handle GET request for SSE connection
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Send initial connection message
      ctx.waitUntil((async () => {
        try {
          // Send server ready message
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {}
          })}\n\n`));

          // Keep connection alive
          const keepAlive = setInterval(() => {
            writer.write(encoder.encode(`: keepalive\n\n`)).catch(() => {
              clearInterval(keepAlive);
            });
          }, 30000);

        } catch (error) {
          console.error('SSE stream error:', error);
        }
      })());

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Accept",
        }
      });
    }

    // Handle JSON-RPC over HTTP POST
    if (url.pathname === "/mcp" && request.method === "POST") {
      try {
        const requestData = await request.json();
        const response = await mcpServer.handleRequest(requestData);

        return new Response(JSON.stringify(response), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error) {
        console.error('MCP request error:', error);
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: "Internal error"
          }
        }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    // Handle root path with basic info
    if (url.pathname === "/") {
      return new Response(JSON.stringify({
        name: "YouTube Transcript Remote MCP Server",
        version: "1.0.0",
        description: "Remote MCP server for extracting YouTube video transcripts",
        endpoints: {
          sse: "/sse",
          mcp: "/mcp"
        },
        tools: ["get_transcript"],
        status: "ready"
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};