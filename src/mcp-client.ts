import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  JsonRpcRequest,
  JsonRpcResponse,
  McpTool,
  McpToolsListResult,
  McpToolCallResult,
  BackendConfig
} from "./types.js";

/**
 * MCP client that starts a child MCP server process and talks to it over stdio.
 */
export class McpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private buffer = "";
  private tools: McpTool[] = [];
  private initialized = false;

  constructor(private config: BackendConfig) {
    super();
  }

  private getSpawnConfig(): { command: string; args: string[] } {
    if (process.platform === "win32" && this.config.command === "npx") {
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", this.config.command, ...this.config.args]
      };
    }

    return {
      command: this.config.command,
      args: this.config.args
    };
  }

  /**
   * Start the child MCP server process and initialize the protocol session.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.config.env };
      const spawnConfig = this.getSpawnConfig();

      this.process = spawn(spawnConfig.command, spawnConfig.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        this.handleData(data.toString());
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        // Treat stderr as backend log output.
        const message = data.toString().trim();
        if (message) {
          // Some backends emit a startup banner before they accept requests.
          if (message.includes("started") || message.includes("listening")) {
            if (!this.initialized) {
              this.initialized = true;
              this.initializeSession().then(resolve).catch(reject);
            }
          }
        }
      });

      this.process.on("error", (error) => {
        reject(error);
      });

      this.process.on("exit", (code) => {
        this.emit("exit", code);
        // Reject all pending requests. Delete first to avoid race conditions.
        for (const [id, pending] of this.pendingRequests) {
          this.pendingRequests.delete(id);
          pending.reject(new Error(`Process exited with code ${code}`));
        }
      });

      // Fall back to a timed initialize attempt if no startup banner arrives.
      setTimeout(() => {
        if (!this.initialized) {
          this.initialized = true;
          this.initializeSession().then(resolve).catch(reject);
        }
      }, 2000);
    });
  }

  /**
   * Perform the MCP initialize handshake and load the tool list.
   */
  private async initializeSession(): Promise<void> {
    // Send initialize.
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "playwright-parallel-mcp",
        version: "0.4.0-plansee.1"
      }
    });

    // Send initialized notification.
    this.sendNotification("notifications/initialized", {});

    // Fetch the tool list.
    const result = await this.sendRequest("tools/list", {}) as McpToolsListResult;
    this.tools = result.tools || [];
  }

  /**
   * Process streamed stdout data from the child process.
   */
  private handleData(data: string): void {
    this.buffer += data;

    // Split newline-delimited JSON-RPC messages.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed) as JsonRpcResponse;
        this.handleMessage(message);
      } catch {
        // Ignore non-JSON log lines.
      }
    }
  }

  /**
   * Resolve or reject the pending request that matches an incoming response.
   */
  private handleMessage(message: JsonRpcResponse): void {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  /**
   * Send a JSON-RPC request and await its response.
   */
  async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error("Process not started");
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + "\n");

      // Guard against backends that stop responding.
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /**
   * Send a JSON-RPC notification without waiting for a response.
   */
  sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin) {
      return;
    }

    const notification = {
      jsonrpc: "2.0",
      method,
      params
    };

    this.process.stdin.write(JSON.stringify(notification) + "\n");
  }

  /**
   * Return the cached tool list.
   */
  getTools(): McpTool[] {
    return this.tools;
  }

  /**
   * Call a backend tool over MCP.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.sendRequest("tools/call", {
      name,
      arguments: args
    });
    return result as McpToolCallResult;
  }

  /**
   * Stop the child process and reject any outstanding requests.
   */
  async stop(): Promise<void> {
    // Reject pending requests before the exit event can race with this cleanup.
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      pending.reject(new Error("Process stopped"));
    }

    if (this.process) {
      // Close stdin explicitly to avoid leaking handles.
      if (this.process.stdin && !this.process.stdin.destroyed) {
        this.process.stdin.end();
      }
      this.process.kill();
      this.process = null;
    }
  }

  /**
   * Report whether the child process is still running.
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
