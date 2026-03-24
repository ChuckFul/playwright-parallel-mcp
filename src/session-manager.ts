import { McpClient } from "./mcp-client.js";
import { checkCdpEndpoint } from "./preflight.js";
import {
  BackendConfig,
  CreateSessionOptions,
  DEFAULT_BACKENDS,
  McpTool,
  McpToolCallResult,
  Preset,
  PresetMap,
  SessionInfo
} from "./types.js";

export interface Session {
  id: string;
  client: McpClient;
  backend: string;
  createdAt: Date;
  lastUsedAt: Date;
}

/**
 * Session manager that owns child MCP backend processes.
 */
class SessionManager {
  private sessions = new Map<string, Session>();
  private maxSessions = parseInt(process.env.MAX_SESSIONS || "10", 10);
  private creating = 0;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private sessionTimeout = parseInt(process.env.SESSION_TIMEOUT_MS || "3600000", 10);
  private cachedTools: McpTool[] | null = null;
  private defaultBackend = process.env.MCP_BACKEND || "playwright";
  private presets: PresetMap;

  constructor() {
    this.presets = this.loadPresets();
    this.startCleanupInterval();
  }

  /**
   * Start the interval that cleans up inactive sessions.
   */
  startCleanupInterval(): void {
    this.stopCleanupInterval();
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSessions().catch(err => {
        console.error("Failed to cleanup inactive sessions:", err);
      });
    }, 300000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop the inactive-session cleanup interval.
   */
  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Close sessions that have exceeded the inactivity timeout.
   */
  async cleanupInactiveSessions(): Promise<number> {
    const now = Date.now();
    const sessionsToClose: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      const lastUsed = session.lastUsedAt.getTime();
      if (now - lastUsed > this.sessionTimeout) {
        sessionsToClose.push(sessionId);
      }
    }

    let closedCount = 0;
    for (const sessionId of sessionsToClose) {
      try {
        await this.closeSession(sessionId);
        closedCount++;
        console.error(`Session ${sessionId} closed due to inactivity`);
      } catch (err) {
        console.error(`Failed to cleanup session ${sessionId}:`, err);
      }
    }

    return closedCount;
  }

  /**
   * Validate npm package names before handing them to npx.
   * @see https://github.com/npm/validate-npm-package-name
   */
  private isValidPackageName(name: string): boolean {
    // Accept scoped (@org/pkg) and unscoped package names.
    // Allow lowercase letters, numbers, hyphens, underscores, dots, and optional versions.
    const packageNamePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9.-]+)?$/;
    return packageNamePattern.test(name);
  }

  private hasExplicitVersion(backend: string): boolean {
    if (!backend.startsWith("@")) {
      return backend.includes("@");
    }

    const slashIndex = backend.indexOf("/");
    if (slashIndex === -1) {
      return false;
    }

    return backend.indexOf("@", slashIndex) !== -1;
  }

  private loadPresets(): PresetMap {
    const raw = process.env.BROWSER_PRESETS;
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw) as PresetMap;
    } catch {
      console.error("Failed to parse BROWSER_PRESETS env var, ignoring");
      return {};
    }
  }

  /**
   * Resolve a backend name into the command config used to launch it.
   */
  private getBackendConfig(backend: string): BackendConfig {
    // Use built-in backend definitions when available.
    if (DEFAULT_BACKENDS[backend]) {
      return DEFAULT_BACKENDS[backend];
    }

    // Custom backends run through npx only.
    // Package-name validation prevents command-injection style input.
    if (!this.isValidPackageName(backend)) {
      throw new Error(
        `Invalid backend package name: "${backend}". ` +
        `Use a valid npm package name or one of: ${Object.keys(DEFAULT_BACKENDS).join(", ")}`
      );
    }

    return {
      command: "npx",
      args: [this.hasExplicitVersion(backend) ? backend : `${backend}@latest`]
    };
  }

  getPresets(): PresetMap {
    return { ...this.presets };
  }

  resolvePreset(presetName: string): Preset | undefined {
    return this.presets[presetName];
  }

  /**
   * Fetch and cache the backend tool list.
   */
  async getAvailableTools(): Promise<McpTool[]> {
    if (this.cachedTools) {
      return this.cachedTools;
    }

    // Start a temporary client to discover the available tools.
    const config = this.getBackendConfig(this.defaultBackend);
    const tempClient = new McpClient(config);

    try {
      await tempClient.start();
      this.cachedTools = tempClient.getTools();
      return this.cachedTools;
    } finally {
      await tempClient.stop();
    }
  }

  /**
   * Create a new isolated backend session.
   */
  async createSession(options: CreateSessionOptions = {}): Promise<Session> {
    // Count in-flight creations before checking capacity to avoid race conditions.
    this.creating++;

    try {
      // Enforce the session limit, including sessions currently being created.
      if (this.sessions.size + this.creating > this.maxSessions) {
        throw new Error(`Maximum number of sessions (${this.maxSessions}) reached. Close existing sessions first.`);
      }

      let resolvedOptions = options;
      if (resolvedOptions.preset) {
        const preset = this.resolvePreset(resolvedOptions.preset);
        if (!preset) {
          throw new Error(
            `Unknown preset: "${resolvedOptions.preset}". Available: ${Object.keys(this.presets).join(", ") || "(none)"}`
          );
        }

        resolvedOptions = {
          ...resolvedOptions,
          cdpEndpoint: resolvedOptions.cdpEndpoint ?? preset.cdpEndpoint,
          backend: resolvedOptions.backend ?? preset.backend
        };
      }

      const backend = resolvedOptions.backend ?? this.defaultBackend;
      const config = this.getBackendConfig(backend);
      const sessionConfig: BackendConfig = {
        command: config.command,
        args: resolvedOptions.cdpEndpoint
          ? [...config.args, "--cdp-endpoint", resolvedOptions.cdpEndpoint]
          : [...config.args],
        env: config.env
      };

      if (resolvedOptions.cdpEndpoint) {
        const preflight = await checkCdpEndpoint(resolvedOptions.cdpEndpoint);
        if (!preflight.listening) {
          throw new Error(
            `CDP preflight failed: ${preflight.error}. ` +
            `Ensure the target application is running with CDP enabled on ${resolvedOptions.cdpEndpoint}.`
          );
        }
      }

      const client = new McpClient(sessionConfig);

      await client.start();

      const now = new Date();
      const session: Session = {
        id: crypto.randomUUID(),
        client,
        backend,
        createdAt: now,
        lastUsedAt: now
      };

      // Add the session before wiring exit cleanup so the handler can always find it.
      this.sessions.set(session.id, session);

      // Remove the session if the backend process exits unexpectedly.
      client.on("exit", () => {
        if (this.sessions.has(session.id)) {
          this.sessions.delete(session.id);
          console.error(`Backend process exited for session ${session.id}`);
        }
      });

      return session;
    } finally {
      this.creating--;
    }
  }

  /**
   * Close a single session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      await session.client.stop();
    } catch (error) {
      console.error(`Error stopping client for session ${sessionId}:`, error);
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Close every active session.
   */
  async closeAllSessions(): Promise<void> {
    const closePromises = Array.from(this.sessions.keys()).map(id =>
      this.closeSession(id).catch(err =>
        console.error(`Failed to close session ${id}:`, err)
      )
    );
    await Promise.all(closePromises);
  }

  /**
   * Return a session by id.
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Refresh the last-used timestamp for a session.
   */
  updateLastUsed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastUsedAt = new Date();
    }
  }

  /**
   * List all active sessions.
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      backend: session.backend,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt
    }));
  }

  /**
   * Call a backend tool through a specific session.
   */
  async callTool(sessionId: string, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.updateLastUsed(sessionId);
    return session.client.callTool(toolName, args);
  }

  /**
   * Return the configured default backend name.
   */
  getDefaultBackend(): string {
    return this.defaultBackend;
  }
}

export const sessionManager = new SessionManager();
