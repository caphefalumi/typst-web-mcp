import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { TypstAuthManager, type AuthManagerOptions } from "./auth.ts";
import {
  CREATE_PROJECT_MUTATION,
  DASHBOARD_CONTENT_QUERY,
  DELETE_FILES_MUTATION,
  DELETE_PROJECT_MUTATION,
  EDIT_PROJECT_MUTATION,
  PROJECT_FILES_QUERY,
  UPDATE_FILES_MUTATION,
  type TypstFileMeta,
  type TypstProjectDetail,
  type TypstProjectSummary,
} from "../protocol/graphql.ts";
import {
  decodeYjsText,
  editYjsText,
  replaceYjsText,
  type TextEditOperation,
} from "../protocol/yjs-doc.ts";
import {
  decodeMessage,
  encodeMessage,
  MessageKind,
} from "../protocol/ws-codec.ts";

const URL_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

export function generateClientId(size = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let id = "";
  for (let i = 0; i < size; i++) {
    id += URL_ALPHABET[bytes[i]! & 63];
  }
  return id;
}

export class TypstLoadError extends Error {
  codes: string[];
  userFacingUrl?: string;
  status?: number;

  constructor(
    codes: string[],
    message?: string,
    userFacingUrl?: string,
    status?: number
  ) {
    super(message ?? `Typst API Error (${codes.join(", ")})`);
    this.name = "TypstLoadError";
    this.codes = codes;
    this.userFacingUrl = userFacingUrl;
    this.status = status;
  }
}

export interface TypstDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  hints: string[];
}

export interface TypstClientOptions extends AuthManagerOptions {
  clientId?: string;
  wsUrl?: string;
  typstBin?: string;
}

export function resolveTypstBinary(explicitBin?: string): string {
  if (explicitBin) return explicitBin;
  if (process.env.TYPST_BIN) return process.env.TYPST_BIN;

  const home = homedir();
  const candidates = [
    join(home, "scoop", "shims", "typst.exe"),
    join(home, ".local", "bin", "typst.exe"),
    join(home, ".local", "bin", "typst"),
    join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", "typst.exe"),
    join(home, ".cargo", "bin", "typst.exe"),
    join(home, ".cargo", "bin", "typst"),
    "/opt/homebrew/bin/typst",
    "/usr/local/bin/typst",
    "/usr/bin/typst",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "typst";
}

export class TypstCloudClient {
  readonly auth: TypstAuthManager;
  readonly clientId: string;
  readonly apiUrl: string;
  readonly wsBaseUrl: string;
  readonly typstBin: string;
  private readonly fetchImpl: typeof fetch;
  private updateCounter = 0;

  constructor(options: TypstClientOptions = {}) {
    this.auth = new TypstAuthManager(options);
    this.clientId = options.clientId ?? generateClientId(8);
    this.apiUrl = this.auth.apiUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.typstBin = resolveTypstBinary(options.typstBin);

    if (options.wsUrl) {
      this.wsBaseUrl = options.wsUrl.replace(/\/+$/, "");
    } else {
      const parsed = new URL(this.apiUrl);
      const proto = parsed.protocol === "https:" ? "wss:" : "ws:";
      this.wsBaseUrl = `${proto}//${parsed.host}`;
    }
  }

  getEditingWebSocketUrl(version = 3): string {
    return `${this.wsBaseUrl}/editing/v${version}?clientId=${this.clientId}`;
  }

  private buildHeaders(
    extraHeaders?: Record<string, string>,
    preflight = true
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...(extraHeaders ?? {}),
    };
    if (preflight) {
      headers["X-Typst-Preflight"] = "true";
    }
    if (this.clientId) {
      headers["X-Typst-Client-Id"] = this.clientId;
    }
    const cookie = this.auth.getCookieHeader();
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    return headers;
  }

  async restCall(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    options?: {
      queryParams?: Record<string, string>;
      headers?: Record<string, string>;
      body?: BodyInit | Uint8Array | ArrayBuffer | null;
      preflight?: boolean;
    }
  ): Promise<{
    response: Response;
    contentType: string;
    etag: string | null;
  }> {
    let url = `${this.apiUrl}/v1/${path.replace(/^\/+/, "")}`;
    if (options?.queryParams && Object.keys(options.queryParams).length > 0) {
      url += `?${new URLSearchParams(options.queryParams).toString()}`;
    }

    const headers = this.buildHeaders(
      options?.headers,
      options?.preflight !== false
    );

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: (options?.body as BodyInit | undefined) ?? undefined,
      });
    } catch (err) {
      throw new TypstLoadError(
        ["NETWORK_FAILURE"],
        err instanceof Error ? err.message : String(err)
      );
    }

    const contentType = (
      res.headers.get("Content-Type") ?? "application/octet-stream"
    )
      .split(";")[0]!
      .toLowerCase();

    if (res.status < 200 || res.status >= 300) {
      if (
        res.status >= 400 &&
        res.status <= 599 &&
        contentType === "application/json"
      ) {
        const body = (await res.json()) as {
          code?: string[];
          message?: string;
          userFacingUrl?: string;
        };
        if (body && Array.isArray(body.code)) {
          throw new TypstLoadError(
            body.code,
            body.message,
            body.userFacingUrl,
            res.status
          );
        }
      }
      if (res.status === 404)
        throw new TypstLoadError(["FILE_NOT_FOUND"], undefined, undefined, 404);
      if (res.status === 413)
        throw new TypstLoadError(["FILE_TOO_LARGE"], undefined, undefined, 413);
      if (res.status === 429)
        throw new TypstLoadError(
          ["RATE_LIMIT_EXCEEDED"],
          undefined,
          undefined,
          429
        );
      if (res.status === 503)
        throw new TypstLoadError(
          ["TEMPORARILY_UNAVAILABLE"],
          undefined,
          undefined,
          503
        );
      throw new TypstLoadError(
        ["UNKNOWN_ERROR"],
        `HTTP ${res.status}`,
        undefined,
        res.status
      );
    }

    return {
      response: res,
      contentType,
      etag: res.headers.get("Etag"),
    };
  }

  async graphql<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const headers = this.buildHeaders(
      { "Content-Type": "application/json" },
      true
    );
    const res = await this.fetchImpl(`${this.apiUrl}/v1/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    if (!res.ok) {
      throw new TypstLoadError(
        ["GRAPHQL_HTTP_ERROR"],
        `GraphQL HTTP ${res.status}`,
        undefined,
        res.status
      );
    }

    const payload = (await res.json()) as {
      data?: T;
      errors?: { message: string; extensions?: Record<string, unknown> }[];
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new TypstLoadError(
        ["GRAPHQL_ERROR"],
        payload.errors.map((e) => e.message).join("; ")
      );
    }

    if (!payload.data) {
      throw new TypstLoadError(["EMPTY_GRAPHQL_DATA"], "Empty GraphQL data");
    }

    return payload.data;
  }

  async listProjects(): Promise<{
    user: { id: string; name: string | null; email?: { address: string } } | null;
    projects: TypstProjectSummary[];
    externalProjects: TypstProjectSummary[];
  }> {
    const data = await this.graphql<{
      user: {
        id: string;
        name: string | null;
        email?: { id: string; address: string; confirmed: boolean };
        projects: TypstProjectSummary[];
        externalProjects: TypstProjectSummary[];
      } | null;
    }>(DASHBOARD_CONTENT_QUERY);

    return {
      user: data.user
        ? {
            id: data.user.id,
            name: data.user.name,
            email: data.user.email,
          }
        : null,
      projects: data.user?.projects ?? [],
      externalProjects: data.user?.externalProjects ?? [],
    };
  }

  async getProject(projectId: string): Promise<TypstProjectDetail> {
    const data = await this.graphql<{
      project: TypstProjectDetail | null;
    }>(PROJECT_FILES_QUERY, { projectId });

    if (!data.project) {
      throw new TypstLoadError(
        ["PROJECT_NOT_FOUND"],
        `Project ${projectId} not found`,
        undefined,
        404
      );
    }

    return data.project;
  }

  async createProject(options: {
    name: string;
    files?: { name: string; content: string }[];
    owner?: string;
    folder?: string;
    pinnedVersion?: string;
  }): Promise<TypstProjectSummary> {
    const defaultFiles = options.files ?? [
      {
        name: "main.typ",
        content: `#set page(paper: "a4")\n#set text(size: 11pt)\n\n= ${options.name}\n`,
      },
    ];

    const data = await this.graphql<{
      createProject: TypstProjectSummary;
    }>(CREATE_PROJECT_MUTATION, {
      name: options.name,
      owner: options.owner ?? null,
      folder: options.folder ?? null,
      files: defaultFiles,
      pinnedVersion: options.pinnedVersion ?? "0.15.1",
    });

    return data.createProject;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const data = await this.graphql<{ deleteProject: boolean }>(
      DELETE_PROJECT_MUTATION,
      { id: projectId }
    );
    return Boolean(data.deleteProject);
  }

  async listFiles(projectId: string): Promise<TypstFileMeta[]> {
    const project = await this.getProject(projectId);
    return project.files;
  }

  async resolveFile(
    projectId: string,
    fileIdOrPath: string
  ): Promise<TypstFileMeta> {
    const files = await this.listFiles(projectId);
    const normalized = fileIdOrPath.replace(/^\/+/, "");
    const match =
      files.find((f) => f.id === fileIdOrPath) ??
      files.find((f) => f.name === normalized || f.name === fileIdOrPath);

    if (!match) {
      throw new TypstLoadError(
        ["FILE_NOT_FOUND"],
        `File "${fileIdOrPath}" not found in project ${projectId}`
      );
    }
    return match;
  }

  async downloadFileYjs(
    projectId: string,
    fileId: string
  ): Promise<Uint8Array> {
    const { response } = await this.restCall(
      "GET",
      `files/${projectId}/${fileId}/yjs`
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async downloadFileBlob(
    projectId: string,
    fileId: string
  ): Promise<Uint8Array> {
    const { response } = await this.restCall(
      "GET",
      `files/${projectId}/${fileId}`
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async readFile(
    projectId: string,
    fileIdOrPath: string
  ): Promise<{
    file: TypstFileMeta;
    content: string;
    encoding: "utf-8" | "base64";
  }> {
    const file = await this.resolveFile(projectId, fileIdOrPath);
    if (file.isMultiplayable) {
      const yjsBytes = await this.downloadFileYjs(projectId, file.id);
      const text = decodeYjsText(yjsBytes);
      return {
        file,
        content: text,
        encoding: "utf-8",
      };
    } else {
      const blob = await this.downloadFileBlob(projectId, file.id);
      return {
        file,
        content: Buffer.from(blob).toString("base64"),
        encoding: "base64",
      };
    }
  }

  /**
   * Pushes a Yjs update over the binary /editing/v3 WebSocket protocol:
   * sends Subscribe(projectId) + TextUpdate(fileId, encodedUpdate, traceparent)
   * and waits for Server Pong acknowledging `traceparent`.
   */
  async pushYjsUpdateViaWebSocket(
    projectId: string,
    fileId: string,
    encodedUpdate: Uint8Array,
    timeoutMs = 5000
  ): Promise<{ acknowledged: boolean; traceparent: string }> {
    const traceparent = `${this.clientId}-${++this.updateCounter}`;
    const wsUrl = this.getEditingWebSocketUrl(3);
    const cookieHeader = this.auth.getCookieHeader();

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const ws = new WebSocket(wsUrl, {
        headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
      } as unknown as string[]);
      ws.binaryType = "arraybuffer";

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {}
          rejectPromise(new Error("WebSocket TextUpdate acknowledgement timed out"));
        }
      }, timeoutMs);

      ws.onopen = () => {
        try {
          ws.send(
            encodeMessage({
              kind: MessageKind.Subscribe,
              rid: projectId,
              from: "0",
              traceparent: "subscribe",
            })
          );
          ws.send(
            encodeMessage({
              kind: MessageKind.TextUpdate,
              fid: fileId,
              encodedUpdate,
              traceparent,
            })
          );
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            ws.close();
            rejectPromise(err);
          }
        }
      };

      ws.onmessage = (event) => {
        try {
          const data =
            event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : event.data instanceof Uint8Array
                ? event.data
                : new Uint8Array(Buffer.from(event.data));
          const msg = decodeMessage(data, "server");
          if (msg.kind === MessageKind.Error) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              ws.close();
              rejectPromise(
                new TypstLoadError(
                  msg.issues,
                  `WebSocket error: ${msg.issues.join(", ")}`
                )
              );
            }
          } else if (
            msg.kind === MessageKind.Pong &&
            msg.traceparent === traceparent
          ) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              ws.close();
              resolvePromise({ acknowledged: true, traceparent });
            }
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            ws.close();
            rejectPromise(err);
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          rejectPromise(new TypstLoadError(["COULD_NOT_CONNECT"]));
        }
      };
    });
  }

  async saveYjsUpdate(
    projectId: string,
    fileId: string,
    encodedUpdate: Uint8Array,
    preferWebSocket = false
  ): Promise<{ syncChannel: "websocket+rest" | "rest" }> {
    let wsSynced = false;
    if (preferWebSocket) {
      try {
        await this.pushYjsUpdateViaWebSocket(projectId, fileId, encodedUpdate);
        wsSynced = true;
      } catch {
        wsSynced = false;
      }
    }
    await this.restCall("PUT", `files/${projectId}/${fileId}/yjs`, {
      body: encodedUpdate,
    });
    return { syncChannel: wsSynced ? "websocket+rest" : "rest" };
  }

  async writeFile(
    projectId: string,
    filePathOrId: string,
    content: string,
    options?: { preferWebSocket?: boolean }
  ): Promise<{
    file: TypstFileMeta;
    created: boolean;
    bytesWritten: number;
    syncChannel: "websocket+rest" | "rest";
  }> {
    const files = await this.listFiles(projectId);
    const normalized = filePathOrId.replace(/^\/+/, "");
    const existing =
      files.find((f) => f.id === filePathOrId) ??
      files.find((f) => f.name === normalized || f.name === filePathOrId);

    if (existing) {
      if (existing.isMultiplayable) {
        const remote = await this.downloadFileYjs(projectId, existing.id);
        const { encodedUpdate } = replaceYjsText(remote, content);
        const { syncChannel } = await this.saveYjsUpdate(
          projectId,
          existing.id,
          encodedUpdate,
          options?.preferWebSocket ?? true
        );
        return {
          file: existing,
          created: false,
          bytesWritten: Buffer.byteLength(content, "utf8"),
          syncChannel,
        };
      } else {
        const rawBytes = new TextEncoder().encode(content);
        const { response } = await this.restCall(
          "PUT",
          `files/${projectId}/${existing.id}`,
          { body: rawBytes }
        );
        const updatedMeta = (await response.json()) as TypstFileMeta;
        return {
          file: updatedMeta,
          created: false,
          bytesWritten: rawBytes.byteLength,
          syncChannel: "rest",
        };
      }
    } else {
      const rawBytes = new TextEncoder().encode(content);
      const { response } = await this.restCall("POST", `files/${projectId}`, {
        queryParams: { name: normalized, convert: "false" },
        body: rawBytes,
      });
      const body = (await response.json()) as TypstFileMeta | TypstFileMeta[];
      const createdMeta = Array.isArray(body) ? body[0]! : body;
      return {
        file: createdMeta,
        created: true,
        bytesWritten: rawBytes.byteLength,
        syncChannel: "rest",
      };
    }
  }

  async editFile(
    projectId: string,
    filePathOrId: string,
    edits: TextEditOperation[],
    options?: { preferWebSocket?: boolean }
  ): Promise<{
    file: TypstFileMeta;
    appliedCount: number;
    previousLength: number;
    updatedLength: number;
    syncChannel: "websocket+rest" | "rest";
  }> {
    const file = await this.resolveFile(projectId, filePathOrId);
    if (!file.isMultiplayable) {
      throw new TypstLoadError(
        ["NOT_MULTIPLAYABLE"],
        `File "${file.name}" is a binary blob and cannot be surgically text-edited`
      );
    }

    const remote = await this.downloadFileYjs(projectId, file.id);
    const { encodedUpdate, previousText, updatedText, appliedCount } =
      editYjsText(remote, edits);

    const { syncChannel } = await this.saveYjsUpdate(
      projectId,
      file.id,
      encodedUpdate,
      options?.preferWebSocket ?? true
    );

    return {
      file,
      appliedCount,
      previousLength: previousText.length,
      updatedLength: updatedText.length,
      syncChannel,
    };
  }

  async uploadAsset(
    projectId: string,
    fileName: string,
    data: Uint8Array,
    options?: { convert?: boolean }
  ): Promise<{
    file: TypstFileMeta;
    replaced: boolean;
    size: number;
  }> {
    const normalized = fileName.replace(/^\/+/, "");
    const files = await this.listFiles(projectId);
    const existing = files.find((f) => f.name === normalized);

    if (existing && !existing.isMultiplayable && !options?.convert) {
      const { response } = await this.restCall(
        "PUT",
        `files/${projectId}/${existing.id}`,
        { body: data }
      );
      const updated = (await response.json()) as TypstFileMeta;
      return {
        file: updated,
        replaced: true,
        size: data.byteLength,
      };
    }

    const { response } = await this.restCall("POST", `files/${projectId}`, {
      queryParams: {
        name: normalized,
        convert: Boolean(options?.convert).toString(),
      },
      body: data,
    });
    const body = (await response.json()) as TypstFileMeta | TypstFileMeta[];
    const created = Array.isArray(body) ? body[0]! : body;
    return {
      file: created,
      replaced: false,
      size: data.byteLength,
    };
  }

  async renameFile(
    projectId: string,
    fileIdOrPath: string,
    newName: string
  ): Promise<{ id: string; name: string }> {
    const file = await this.resolveFile(projectId, fileIdOrPath);
    const normalizedNewName = newName.replace(/^\/+/, "");
    const data = await this.graphql<{
      updateFiles: { id: string; name: string }[];
    }>(UPDATE_FILES_MUTATION, {
      projectId,
      updates: [{ id: file.id, fileName: normalizedNewName }],
    });
    return (
      data.updateFiles[0] ?? {
        id: file.id,
        name: normalizedNewName,
      }
    );
  }

  async deleteFile(
    projectId: string,
    fileIdOrPath: string
  ): Promise<{ deletedId: string; name: string }> {
    const file = await this.resolveFile(projectId, fileIdOrPath);
    await this.graphql<{ deleteFiles: string[] }>(DELETE_FILES_MUTATION, {
      projectId,
      ids: [file.id],
    });
    return { deletedId: file.id, name: file.name };
  }

  /**
   * Synchronizes all project files (decoding Yjs CRDT text files and downloading binary blobs)
   * into a temporary local workspace directory and returns the main file path.
   */
  private async materializeProjectWorkspace(
    projectId: string,
    mainFileOverride?: string
  ): Promise<{
    workspaceDir: string;
    mainFileName: string;
    project: TypstProjectDetail;
  }> {
    const project = await this.getProject(projectId);
    const workspaceDir = mkdtempSync(join(tmpdir(), `typst-mcp-${projectId}-`));

    for (const file of project.files) {
      const targetPath = join(workspaceDir, file.name);
      mkdirSync(dirname(targetPath), { recursive: true });
      if (file.isMultiplayable) {
        const yjsBytes = await this.downloadFileYjs(projectId, file.id);
        const text = decodeYjsText(yjsBytes);
        writeFileSync(targetPath, text, "utf8");
      } else {
        const blobBytes = await this.downloadFileBlob(projectId, file.id);
        writeFileSync(targetPath, blobBytes);
      }
    }

    let mainFileName = mainFileOverride?.replace(/^\/+/, "");
    if (!mainFileName && project.previewed) {
      mainFileName = project.files.find((f) => f.id === project.previewed)?.name;
    }
    if (!mainFileName) {
      mainFileName =
        project.files.find((f) => f.name === "main.typ")?.name ??
        project.files.find((f) => f.name.endsWith(".typ"))?.name;
    }
    if (!mainFileName) {
      rmSync(workspaceDir, { recursive: true, force: true });
      throw new TypstLoadError(
        ["NO_TYPST_MAIN_FILE"],
        `No .typ file found in project ${projectId}`
      );
    }

    return { workspaceDir, mainFileName, project };
  }

  static parseShortDiagnostics(stderrText: string): TypstDiagnostic[] {
    const diagnostics: TypstDiagnostic[] = [];
    const lines = stderrText.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      // Short format: path:line:col: error|warning: message
      const match = line.match(
        /^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.+)$/i
      );
      if (match) {
        diagnostics.push({
          path: match[1]!.replace(/\\/g, "/"),
          line: Number.parseInt(match[2]!, 10),
          column: Number.parseInt(match[3]!, 10),
          severity: match[4]!.toLowerCase() as "error" | "warning",
          message: match[5]!,
          hints: [],
        });
      } else if (
        line.toLowerCase().startsWith("hint:") &&
        diagnostics.length > 0
      ) {
        diagnostics[diagnostics.length - 1]!.hints.push(
          line.replace(/^hint:\s*/i, "")
        );
      }
    }
    return diagnostics;
  }

  async getDiagnostics(
    projectId: string,
    mainFile?: string
  ): Promise<{
    projectId: string;
    mainFile: string;
    success: boolean;
    errorCount: number;
    warningCount: number;
    diagnostics: TypstDiagnostic[];
  }> {
    const { workspaceDir, mainFileName } =
      await this.materializeProjectWorkspace(projectId, mainFile);
    try {
      const outPdf = join(workspaceDir, "__check__.pdf");
      const proc = spawnSync(
        this.typstBin,
        [
          "compile",
          "--diagnostic-format",
          "short",
          "--root",
          workspaceDir,
          join(workspaceDir, mainFileName),
          outPdf,
        ],
        {
          cwd: workspaceDir,
          encoding: "utf8",
        }
      );

      const combinedOutput = `${proc.stderr ?? ""}\n${proc.stdout ?? ""}`;
      const diagnostics = TypstCloudClient.parseShortDiagnostics(combinedOutput).map(
        (d) => ({
          ...d,
          path: d.path.startsWith(workspaceDir.replace(/\\/g, "/"))
            ? d.path
                .slice(workspaceDir.replace(/\\/g, "/").length)
                .replace(/^\/+/, "")
            : d.path,
        })
      );

      const errorCount = diagnostics.filter((d) => d.severity === "error").length;
      const warningCount = diagnostics.filter(
        (d) => d.severity === "warning"
      ).length;

      return {
        projectId,
        mainFile: mainFileName,
        success: proc.status === 0 && errorCount === 0,
        errorCount,
        warningCount,
        diagnostics,
      };
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  async exportPdf(
    projectId: string,
    options?: {
      mainFile?: string;
      outputPath?: string;
    }
  ): Promise<{
    projectId: string;
    mainFile: string;
    outputPath: string;
    sizeBytes: number;
    pdfHeader: string;
    diagnostics: TypstDiagnostic[];
  }> {
    const { workspaceDir, mainFileName, project } =
      await this.materializeProjectWorkspace(projectId, options?.mainFile);
    try {
      const safeName = project.name.replace(/[^a-zA-Z0-9._-]+/g, "_") || projectId;
      const outputPath = options?.outputPath
        ? resolve(options.outputPath)
        : join(tmpdir(), `${safeName}.pdf`);
      mkdirSync(dirname(outputPath), { recursive: true });

      const proc = spawnSync(
        this.typstBin,
        [
          "compile",
          "--diagnostic-format",
          "short",
          "--root",
          workspaceDir,
          join(workspaceDir, mainFileName),
          outputPath,
        ],
        {
          cwd: workspaceDir,
          encoding: "utf8",
        }
      );

      const combinedOutput = `${proc.stderr ?? ""}\n${proc.stdout ?? ""}`;
      const diagnostics = TypstCloudClient.parseShortDiagnostics(combinedOutput);

      if (proc.status !== 0) {
        throw new TypstLoadError(
          ["EXPORT_COMPILATION_FAILED"],
          `Failed to compile PDF for ${mainFileName}: ${
            diagnostics.map((d) => `${d.path}:${d.line}:${d.column} ${d.message}`).join("; ") ||
            combinedOutput.trim()
          }`
        );
      }

      const pdfBytes = readFileSync(outputPath);
      return {
        projectId,
        mainFile: mainFileName,
        outputPath,
        sizeBytes: pdfBytes.byteLength,
        pdfHeader: pdfBytes.subarray(0, 8).toString("utf8"),
        diagnostics,
      };
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  /**
   * Captures high-resolution PNG preview screenshots to verify the current visual status
   * of a Typst project (`mode: "pages"` renders compiled PNG pages at `ppi` DPI via Typst;
   * `mode: "browser"` captures the live https://typst.app/project/:id web editor + preview pane via Playwright).
   */
  async capturePreviewScreenshot(
    projectId: string,
    options?: {
      mainFile?: string;
      outputDir?: string;
      pages?: string;
      ppi?: number;
      mode?: "pages" | "browser";
      includeBase64?: boolean;
    }
  ): Promise<{
    projectId: string;
    mode: "pages" | "browser";
    mainFile: string;
    outputDir: string;
    ppi: number;
    pageCount: number;
    screenshots: {
      page: number;
      path: string;
      sizeBytes: number;
      pngSignatureValid: boolean;
      base64?: string;
    }[];
    diagnostics: TypstDiagnostic[];
  }> {
    const mode = options?.mode ?? "pages";
    const ppi = options?.ppi ?? 144;

    if (mode === "browser") {
      const outputDir = options?.outputDir
        ? resolve(options.outputDir)
        : mkdtempSync(join(tmpdir(), `typst-preview-ui-${projectId}-`));
      mkdirSync(outputDir, { recursive: true });
      const screenshotPath = join(outputDir, `typst-app-${projectId}.png`);
      const cookieHeader = this.auth.getCookieHeader();

      const pyScript = `
import os
from playwright.sync_api import sync_playwright

app_url = os.environ["TYPST_PREVIEW_APP_URL"]
proj_id = os.environ["TYPST_PREVIEW_PROJ_ID"]
out_path = os.environ["TYPST_PREVIEW_OUT"]
raw_cookie = os.environ.get("TYPST_PREVIEW_COOKIE", "")

cookies = []
for part in raw_cookie.split(";"):
    part = part.strip()
    if "=" in part:
        k, v = part.split("=", 1)
        cookies.append({
            "name": k.strip(),
            "value": v.strip(),
            "domain": "typst.app",
            "path": "/",
            "secure": True,
        })

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=2)
    if cookies:
        ctx.add_cookies(cookies)
    page = ctx.new_page()
    page.goto(f"{app_url}/project/{proj_id}", wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(3000)
    page.screenshot(path=out_path, full_page=False)
    browser.close()
`;
      const proc = spawnSync("python", ["-c", pyScript], {
        env: {
          ...process.env,
          TYPST_PREVIEW_APP_URL: this.auth.appUrl,
          TYPST_PREVIEW_PROJ_ID: projectId,
          TYPST_PREVIEW_OUT: screenshotPath,
          TYPST_PREVIEW_COOKIE: cookieHeader,
        },
        encoding: "utf8",
        timeout: 65000,
      });

      if (proc.status !== 0 || !existsSync(screenshotPath)) {
        throw new TypstLoadError(
          ["BROWSER_SCREENSHOT_FAILED"],
          `Failed to capture live browser preview screenshot: ${proc.stderr || "unknown error"}`
        );
      }

      const bytes = readFileSync(screenshotPath);
      const isPng =
        bytes.byteLength >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47;

      return {
        projectId,
        mode: "browser",
        mainFile: options?.mainFile ?? "main.typ",
        outputDir,
        ppi,
        pageCount: 1,
        screenshots: [
          {
            page: 1,
            path: screenshotPath,
            sizeBytes: bytes.byteLength,
            pngSignatureValid: isPng,
            base64: options?.includeBase64 ? bytes.toString("base64") : undefined,
          },
        ],
        diagnostics: [],
      };
    }

    const { workspaceDir, mainFileName, project } =
      await this.materializeProjectWorkspace(projectId, options?.mainFile);
    try {
      const safeName =
        project.name.replace(/[^a-zA-Z0-9._-]+/g, "_") || projectId;
      const outputDir = options?.outputDir
        ? resolve(options.outputDir)
        : mkdtempSync(join(tmpdir(), `typst-preview-${safeName}-`));
      mkdirSync(outputDir, { recursive: true });

      const outputTemplate = join(outputDir, "page-{0p}.png");
      const args = [
        "compile",
        "--format",
        "png",
        "--ppi",
        String(ppi),
        "--diagnostic-format",
        "short",
        "--root",
        workspaceDir,
      ];
      if (options?.pages && options.pages !== "all") {
        args.push("--pages", options.pages);
      }
      args.push(join(workspaceDir, mainFileName), outputTemplate);

      const proc = spawnSync(this.typstBin, args, {
        cwd: workspaceDir,
        encoding: "utf8",
      });

      const combinedOutput = `${proc.stderr ?? ""}\n${proc.stdout ?? ""}`;
      const diagnostics = TypstCloudClient.parseShortDiagnostics(combinedOutput);

      if (proc.status !== 0) {
        throw new TypstLoadError(
          ["PREVIEW_SCREENSHOT_COMPILATION_FAILED"],
          `Failed to render PNG preview for ${mainFileName}: ${
            diagnostics
              .map((d) => `${d.path}:${d.line}:${d.column} ${d.message}`)
              .join("; ") || combinedOutput.trim()
          }`
        );
      }

      const files = readdirSync(outputDir)
        .filter((f) => /^page-\d+\.png$/i.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      const screenshots = files.map((fileName, idx) => {
        const fullPath = join(outputDir, fileName);
        const bytes = readFileSync(fullPath);
        const pageMatch = fileName.match(/page-(\d+)\.png/i);
        const pageNum = pageMatch ? Number.parseInt(pageMatch[1]!, 10) : idx + 1;
        const isPng =
          bytes.byteLength >= 8 &&
          bytes[0] === 0x89 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x4e &&
          bytes[3] === 0x47;
        return {
          page: pageNum,
          path: fullPath,
          sizeBytes: bytes.byteLength,
          pngSignatureValid: isPng,
          base64: options?.includeBase64 ? bytes.toString("base64") : undefined,
        };
      });

      return {
        projectId,
        mode: "pages",
        mainFile: mainFileName,
        outputDir,
        ppi,
        pageCount: screenshots.length,
        screenshots,
        diagnostics,
      };
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
}
