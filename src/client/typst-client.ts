import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TypstAuthManager, type AuthManagerOptions } from "./auth.js";
import { TypstLoadError, formatUnknownError } from "./errors.js";
import {
  captureBrowserPreviewScreenshot,
  captureWorkspacePageScreenshots,
  compileWorkspaceDiagnostics,
  compileWorkspacePdf,
  parseShortDiagnostics,
  resolveTypstBinary,
  type PreviewScreenshotItem,
  type TypstDiagnostic,
} from "./compiler.js";
import {
  CREATE_PROJECT_MUTATION,
  DASHBOARD_CONTENT_QUERY,
  DELETE_FILES_MUTATION,
  DELETE_PROJECT_MUTATION,
  PROJECT_FILES_QUERY,
  UPDATE_FILES_MUTATION,
  type TypstFileMeta,
  type TypstProjectDetail,
  type TypstProjectSummary,
} from "../protocol/graphql.js";
import {
  decodeYjsText,
  editYjsText,
  replaceYjsText,
  type TextEditOperation,
} from "../protocol/yjs-doc.js";
import {
  decodeMessage,
  encodeMessage,
  MessageKind,
} from "../protocol/ws-codec.js";
import {
  truncateHead,
  formatSize,
  type TruncationResult,
} from "../utils/truncate.js";
import { detectSupportedImageMimeType } from "../utils/mime.js";
import { withFileMutationQueue } from "../utils/file-mutation-queue.js";
import {
  matchGlob,
  searchInContent,
  replaceInContent,
  type GrepMatch,
} from "../protocol/search-replace.js";

export { TypstLoadError, resolveTypstBinary, type TypstDiagnostic };

export interface GrepProjectOptions {
  pattern: string;
  path?: string;
  glob?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
  limit?: number;
}

export interface GrepProjectResult {
  matches: GrepMatch[];
  totalMatches: number;
  filesSearched: number;
  truncated: boolean;
}

export interface FindAndReplaceOptions {
  pattern: string;
  replacement: string;
  filePath?: string;
  glob?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  limit?: number;
  dryRun?: boolean;
  preferWebSocket?: boolean;
}

export interface FindAndReplaceResult {
  filesModified: Array<{
    file: string;
    replacementsCount: number;
    diff: string;
    patch: string;
    firstChangedLine?: number;
  }>;
  totalReplacements: number;
  dryRun: boolean;
}

export interface ReadFileOptions {
  offset?: number;
  limit?: number;
  lineNumbers?: boolean;
  maxLines?: number;
  maxBytes?: number;
}

export interface TypstReadFileResult {
  file: TypstFileMeta;
  content: string;
  encoding: "utf-8" | "base64";
  mimeType?: string;
  isImage?: boolean;
  truncation?: TruncationResult;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
}

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

function resolveWebSocketBaseUrl(apiUrl: string, wsUrl?: string): string {
  if (wsUrl) {
    return wsUrl.replace(/\/+$/, "");
  }
  const parsed = new URL(apiUrl);
  let proto = "ws:";
  if (parsed.protocol === "https:") {
    proto = "wss:";
  }
  return `${proto}//${parsed.host}`;
}

function toUint8ArrayPayload(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(Buffer.from(data as string | Buffer));
}

function unwrapSingleOrFirstFile(
  body: TypstFileMeta | TypstFileMeta[]
): TypstFileMeta {
  if (Array.isArray(body)) {
    return body[0]!;
  }
  return body;
}

export interface TypstClientOptions extends AuthManagerOptions {
  clientId?: string;
  wsUrl?: string;
  typstBin?: string;
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
    this.wsBaseUrl = resolveWebSocketBaseUrl(this.apiUrl, options.wsUrl);
  }

  getEditingWebSocketUrl(version = 3): string {
    const url = new URL(`/editing/v${version}`, this.wsBaseUrl);
    url.searchParams.set("clientId", this.clientId);
    return url.toString();
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
    const urlObj = new URL(
      `/v1/${path.replace(/^\/+/, "")}`,
      this.apiUrl
    );
    if (options?.queryParams) {
      for (const [k, v] of Object.entries(options.queryParams)) {
        urlObj.searchParams.set(k, v);
      }
    }

    const headers = this.buildHeaders(
      options?.headers,
      options?.preflight !== false
    );

    let res: Response;
    try {
      res = await this.fetchImpl(urlObj.toString(), {
        method,
        headers,
        body: (options?.body as BodyInit | undefined) ?? undefined,
      });
    } catch (err) {
      throw new TypstLoadError(["NETWORK_FAILURE"], formatUnknownError(err));
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
      if (res.status === 404) {
        throw new TypstLoadError(["FILE_NOT_FOUND"], undefined, undefined, 404);
      }
      if (res.status === 413) {
        throw new TypstLoadError(["FILE_TOO_LARGE"], undefined, undefined, 413);
      }
      if (res.status === 429) {
        throw new TypstLoadError(
          ["RATE_LIMIT_EXCEEDED"],
          undefined,
          undefined,
          429
        );
      }
      if (res.status === 503) {
        throw new TypstLoadError(
          ["TEMPORARILY_UNAVAILABLE"],
          undefined,
          undefined,
          503
        );
      }
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
    user: {
      id: string;
      name: string | null;
      email?: { address: string };
    } | null;
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

    let userSummary: {
      id: string;
      name: string | null;
      email?: { address: string };
    } | null = null;

    if (data.user) {
      userSummary = {
        id: data.user.id,
        name: data.user.name,
        email: data.user.email,
      };
    }

    return {
      user: userSummary,
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
    fileIdOrPath: string,
    options?: ReadFileOptions
  ): Promise<TypstReadFileResult> {
    const file = await this.resolveFile(projectId, fileIdOrPath);
    if (file.isMultiplayable) {
      const yjsBytes = await this.downloadFileYjs(projectId, file.id);
      const text = decodeYjsText(yjsBytes);
      const allLines = text.split("\n");
      const totalLines = allLines.length;

      if (options?.offset !== undefined && options.offset > totalLines) {
        throw new Error(
          `Offset ${options.offset} is beyond end of file (${totalLines} lines total)`
        );
      }

      const startLine = options?.offset ? Math.max(0, options.offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      let selectedContent: string;
      let userLimitedLines: number | undefined;

      if (options?.limit !== undefined) {
        const endLine = Math.min(startLine + options.limit, totalLines);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent, {
        maxLines: options?.maxLines,
        maxBytes: options?.maxBytes,
      });

      let outputText: string;
      let endLineDisplay = startLineDisplay;

      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(
          Buffer.byteLength(allLines[startLine] ?? "", "utf-8")
        );
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(
          truncation.maxBytes
        )} limit]`;
      } else if (truncation.truncated) {
        endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        let body = truncation.content;
        if (options?.lineNumbers) {
          const lines = body.split("\n");
          const width = String(endLineDisplay).length;
          body = lines
            .map(
              (line, idx) =>
                `${String(startLineDisplay + idx).padStart(width, " ")} | ${line}`
            )
            .join("\n");
        }
        if (truncation.truncatedBy === "lines") {
          outputText = `${body}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText = `${body}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatSize(
            truncation.maxBytes
          )} limit). Use offset=${nextOffset} to continue.]`;
        }
      } else if (
        userLimitedLines !== undefined &&
        startLine + userLimitedLines < totalLines
      ) {
        endLineDisplay = startLine + userLimitedLines;
        const remaining = totalLines - endLineDisplay;
        const nextOffset = endLineDisplay + 1;
        let body = truncation.content;
        if (options?.lineNumbers) {
          const lines = body.split("\n");
          const width = String(endLineDisplay).length;
          body = lines
            .map(
              (line, idx) =>
                `${String(startLineDisplay + idx).padStart(width, " ")} | ${line}`
            )
            .join("\n");
        }
        outputText = `${body}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        endLineDisplay = totalLines;
        let body = truncation.content;
        if (options?.lineNumbers) {
          const lines = body.split("\n");
          const width = String(startLineDisplay + lines.length - 1).length;
          body = lines
            .map(
              (line, idx) =>
                `${String(startLineDisplay + idx).padStart(width, " ")} | ${line}`
            )
            .join("\n");
        }
        outputText = body;
      }

      return {
        file,
        content: outputText,
        encoding: "utf-8",
        totalLines,
        startLine: startLineDisplay,
        endLine: endLineDisplay,
        truncation: truncation.truncated ? truncation : undefined,
      };
    }
    const blob = await this.downloadFileBlob(projectId, file.id);
    const mimeType = detectSupportedImageMimeType(file.name);
    const isImage = Boolean(mimeType && mimeType.startsWith("image/"));
    return {
      file,
      content: Buffer.from(blob).toString("base64"),
      encoding: "base64",
      mimeType,
      isImage,
    };
  }

  async pushYjsUpdateViaWebSocket(
    projectId: string,
    fileId: string,
    encodedUpdate: Uint8Array,
    timeoutMs = 5000
  ): Promise<{ acknowledged: boolean; traceparent: string }> {
    const traceparent = `${this.clientId}-${++this.updateCounter}`;
    const wsUrl = this.getEditingWebSocketUrl(3);
    const cookieHeader = this.auth.getCookieHeader();

    let wsHeaders: Record<string, string> | undefined;
    if (cookieHeader) {
      wsHeaders = { Cookie: cookieHeader };
    }

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const ws = new WebSocket(wsUrl, {
        headers: wsHeaders,
      } as unknown as string[]);
      ws.binaryType = "arraybuffer";

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {}
          rejectPromise(
            new Error("WebSocket TextUpdate acknowledgement timed out")
          );
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
          const data = toUint8ArrayPayload(event.data);
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
    let syncChannel: "websocket+rest" | "rest" = "rest";
    if (preferWebSocket) {
      try {
        await this.pushYjsUpdateViaWebSocket(projectId, fileId, encodedUpdate);
        syncChannel = "websocket+rest";
      } catch {
        syncChannel = "rest";
      }
    }
    await this.restCall("PUT", `files/${projectId}/${fileId}/yjs`, {
      body: encodedUpdate,
    });
    return { syncChannel };
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
    const normalized = filePathOrId.replace(/^\/+/, "");
    return withFileMutationQueue(`${projectId}:${normalized}`, async () => {
      const files = await this.listFiles(projectId);
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
        }
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

      const rawBytes = new TextEncoder().encode(content);
      const { response } = await this.restCall("POST", `files/${projectId}`, {
        queryParams: { name: normalized, convert: "false" },
        body: rawBytes,
      });
      const body = (await response.json()) as TypstFileMeta | TypstFileMeta[];
      const createdMeta = unwrapSingleOrFirstFile(body);
      return {
        file: createdMeta,
        created: true,
        bytesWritten: rawBytes.byteLength,
        syncChannel: "rest",
      };
    });
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
    diff: string;
    patch: string;
    firstChangedLine?: number;
    syncChannel: "websocket+rest" | "rest";
  }> {
    const file = await this.resolveFile(projectId, filePathOrId);
    if (!file.isMultiplayable) {
      throw new TypstLoadError(
        ["NOT_MULTIPLAYABLE"],
        `File "${file.name}" is a binary blob and cannot be surgically text-edited`
      );
    }

    return withFileMutationQueue(`${projectId}:${file.id}`, async () => {
      const remote = await this.downloadFileYjs(projectId, file.id);
      const {
        encodedUpdate,
        previousText,
        updatedText,
        appliedCount,
        diff,
        patch,
        firstChangedLine,
      } = editYjsText(remote, edits, file.name);

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
        diff,
        patch,
        firstChangedLine,
        syncChannel,
      };
    });
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
    const created = unwrapSingleOrFirstFile(body);
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
    return parseShortDiagnostics(stderrText);
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
      return compileWorkspaceDiagnostics({
        typstBin: this.typstBin,
        projectId,
        workspaceDir,
        mainFileName,
      });
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
      return compileWorkspacePdf({
        typstBin: this.typstBin,
        projectId,
        projectName: project.name,
        workspaceDir,
        mainFileName,
        outputPath: options?.outputPath,
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

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
    screenshots: PreviewScreenshotItem[];
    diagnostics: TypstDiagnostic[];
  }> {
    const mode = options?.mode ?? "pages";
    const ppi = options?.ppi ?? 144;

    if (mode === "browser") {
      return captureBrowserPreviewScreenshot({
        appUrl: this.auth.appUrl,
        projectId,
        cookieHeader: this.auth.getCookieHeader(),
        mainFile: options?.mainFile,
        outputDir: options?.outputDir,
        ppi,
        includeBase64: options?.includeBase64,
      });
    }

    const { workspaceDir, mainFileName, project } =
      await this.materializeProjectWorkspace(projectId, options?.mainFile);
    try {
      return captureWorkspacePageScreenshots({
        typstBin: this.typstBin,
        projectId,
        projectName: project.name,
        workspaceDir,
        mainFileName,
        outputDir: options?.outputDir,
        pages: options?.pages,
        ppi,
        includeBase64: options?.includeBase64,
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  async grepProject(
    projectId: string,
    options: GrepProjectOptions
  ): Promise<GrepProjectResult> {
    const files = await this.listFiles(projectId);
    const limit = options.limit ?? 100;
    const allMatches: GrepMatch[] = [];
    let totalMatches = 0;
    let filesSearched = 0;

    for (const file of files) {
      if (!file.isMultiplayable) continue;

      if (options.path) {
        const normalizedPath = options.path.replace(/^\/+/, "");
        if (
          file.name !== normalizedPath &&
          !file.name.startsWith(`${normalizedPath}/`) &&
          file.id !== options.path
        ) {
          continue;
        }
      }

      if (options.glob && !matchGlob(file.name, options.glob)) {
        continue;
      }

      filesSearched++;
      const yjsBytes = await this.downloadFileYjs(projectId, file.id);
      const text = decodeYjsText(yjsBytes);

      const remainingLimit = Math.max(0, limit - allMatches.length);
      const result = searchInContent(file.name, text, {
        pattern: options.pattern,
        literal: options.literal,
        ignoreCase: options.ignoreCase,
        context: options.context,
        limit: remainingLimit,
      });

      totalMatches += result.totalMatches;
      allMatches.push(...result.matches);
    }

    return {
      matches: allMatches,
      totalMatches,
      filesSearched,
      truncated: totalMatches > allMatches.length,
    };
  }

  async findAndReplace(
    projectId: string,
    options: FindAndReplaceOptions
  ): Promise<FindAndReplaceResult> {
    const files = await this.listFiles(projectId);
    const filesModified: FindAndReplaceResult["filesModified"] = [];
    let totalReplacements = 0;

    for (const file of files) {
      if (!file.isMultiplayable) continue;

      if (options.filePath) {
        const normalizedPath = options.filePath.replace(/^\/+/, "");
        if (file.name !== normalizedPath && file.id !== options.filePath) {
          continue;
        }
      }

      if (options.glob && !matchGlob(file.name, options.glob)) {
        continue;
      }

      await withFileMutationQueue(`${projectId}:${file.id}`, async () => {
        const remote = await this.downloadFileYjs(projectId, file.id);
        const text = decodeYjsText(remote);

        const repResult = replaceInContent(file.name, text, {
          pattern: options.pattern,
          replacement: options.replacement,
          regex: options.regex,
          ignoreCase: options.ignoreCase,
          limit: options.limit,
        });

        if (repResult.replacementCount > 0) {
          if (!options.dryRun) {
            const { encodedUpdate } = replaceYjsText(
              remote,
              repResult.updatedText
            );
            await this.saveYjsUpdate(
              projectId,
              file.id,
              encodedUpdate,
              options.preferWebSocket ?? true
            );
          }

          filesModified.push({
            file: file.name,
            replacementsCount: repResult.replacementCount,
            diff: repResult.diff,
            patch: repResult.patch,
            firstChangedLine: repResult.firstChangedLine,
          });
          totalReplacements += repResult.replacementCount;
        }
      });
    }

    return {
      filesModified,
      totalReplacements,
      dryRun: Boolean(options.dryRun),
    };
  }
}
