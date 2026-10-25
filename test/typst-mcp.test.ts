import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
import * as Y from "yjs";
import {
  decodeMessage,
  encodeMessage,
  MessageKind,
  ProtocolDirectionalityError,
  RefreshAction,
  RefreshDomain,
} from "../src/protocol/ws-codec.ts";
import {
  createInitialYjsUpdate,
  decodeYjsText,
  editYjsText,
  replaceYjsText,
} from "../src/protocol/yjs-doc.ts";
import { TypstCloudClient } from "../src/client/typst-client.ts";
import {
  hasTypstBinary,
  offsetToPosition,
  resolvePythonBinary,
} from "../src/client/compiler.ts";
import { dispatchTypstTool, TYPST_MCP_TOOLS } from "../src/index.ts";

describe("1. Binary WebSocket /editing/v3 Wire Codec", () => {
  test("encodes and decodes Subscribe, TextUpdate, Pong, Refresh, Presence, Cursor, Error, Leave", () => {
    const subBytes = encodeMessage({
      kind: MessageKind.Subscribe,
      rid: "proj_123",
      from: "0",
      traceparent: "subscribe",
    });
    const subDecoded = decodeMessage(subBytes, "client");
    expect(subDecoded).toEqual({
      kind: MessageKind.Subscribe,
      rid: "proj_123",
      from: "0",
      traceparent: "subscribe",
    });

    const yUpdate = createInitialYjsUpdate("= Hello Typst\n");
    const txtBytes = encodeMessage({
      kind: MessageKind.TextUpdate,
      fid: "file_main",
      encodedUpdate: yUpdate,
      traceparent: "clientA-1",
    });
    const txtDecoded = decodeMessage(txtBytes, "client");
    expect(txtDecoded.kind).toBe(MessageKind.TextUpdate);
    if (txtDecoded.kind === MessageKind.TextUpdate) {
      expect(txtDecoded.fid).toBe("file_main");
      expect(txtDecoded.traceparent).toBe("clientA-1");
      expect(decodeYjsText(txtDecoded.encodedUpdate)).toBe("= Hello Typst\n");
    }

    const pongBytes = encodeMessage({
      kind: MessageKind.Pong,
      traceparent: "clientA-1",
    });
    const pongDecoded = decodeMessage(pongBytes, "server");
    expect(pongDecoded).toEqual({
      kind: MessageKind.Pong,
      traceparent: "clientA-1",
    });

    const refreshBytes = encodeMessage({
      kind: MessageKind.Refresh,
      domain: RefreshDomain.File,
      action: RefreshAction.Create,
      ids: ["f1", "f2"],
    });
    const refreshDecoded = decodeMessage(refreshBytes, "server");
    expect(refreshDecoded).toEqual({
      kind: MessageKind.Refresh,
      domain: RefreshDomain.File,
      action: RefreshAction.Create,
      ids: ["f1", "f2"],
    });

    const presenceBytes = encodeMessage({
      kind: MessageKind.Presence,
      peerId: "peer_1",
      uid: "user_1",
      name: "Toan",
      avatar: true,
      presenting: false,
      activeFile: "file_main",
    });
    expect(decodeMessage(presenceBytes, "server")).toEqual({
      kind: MessageKind.Presence,
      peerId: "peer_1",
      uid: "user_1",
      name: "Toan",
      avatar: true,
      presenting: false,
      activeFile: "file_main",
    });

    const cursorBytes = encodeMessage({
      kind: MessageKind.Cursor,
      peerId: "peer_1",
      cursor: {
        anchor: { client: 10, clock: 5 },
        head: { client: 10, clock: 12 },
      },
    });
    expect(decodeMessage(cursorBytes, "server")).toEqual({
      kind: MessageKind.Cursor,
      peerId: "peer_1",
      cursor: {
        anchor: { client: 10, clock: 5 },
        head: { client: 10, clock: 12 },
      },
    });

    // Directionality guard: Subscribe cannot come from server
    expect(() => decodeMessage(subBytes, "server")).toThrow(
      ProtocolDirectionalityError
    );
  });
});

describe("2. Yjs CRDT Document Operations", () => {
  test("creates, replaces, and surgically edits multiplayer Yjs text", () => {
    const initial = createInitialYjsUpdate(
      "#set page(paper: \"a4\")\n\n= Introduction\nDraft paragraph one.\n\n= Conclusion\nOld summary.\n"
    );
    expect(decodeYjsText(initial)).toContain("Draft paragraph one.");

    const edited = editYjsText(initial, [
      {
        oldText: "Draft paragraph one.",
        newText: "Updated first paragraph with formula $E = m c^2$.",
      },
      {
        oldText: "Old summary.",
        newText: "Final verified conclusion.",
      },
    ]);

    expect(edited.appliedCount).toBe(2);
    expect(edited.updatedText).toContain(
      "Updated first paragraph with formula $E = m c^2$."
    );
    expect(edited.updatedText).toContain("Final verified conclusion.");

    // Applying the incremental update to a replica Y.Doc converges to the exact same state
    const replica = new Y.Doc();
    Y.applyUpdate(replica, initial);
    Y.applyUpdate(replica, edited.encodedUpdate);
    expect(replica.getText("text").toString()).toBe(edited.updatedText);
    replica.destroy();

    const replaced = replaceYjsText(edited.mergedState, "= Clean Slate\n");
    expect(decodeYjsText(replaced.mergedState)).toBe("= Clean Slate\n");
  });
});

describe("3. End-to-End Mock typst.app Server & All 15 MCP Tools", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let wsBaseUrl: string;
  let tempDir: string;
  let blockDirectLoginWithChallenge = false;

  interface MockFileRecord {
    id: string;
    name: string;
    isMultiplayable: boolean;
    yjsState?: Uint8Array;
    blobBytes?: Uint8Array;
    size: number;
    version: number;
    lastChangeDate: number;
  }

  interface MockProjectRecord {
    id: string;
    name: string;
    previewed: string | null;
    pinnedVersion: string;
    files: Map<string, MockFileRecord>;
  }

  const projects = new Map<string, MockProjectRecord>();
  const wsUpdateLog: { projectId: string; fileId: string; traceparent?: string }[] = [];

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "typst-mcp-test-"));

    // Seed an initial project
    const mainYjs = createInitialYjsUpdate(
      "#set page(paper: \"a4\")\n\n= Initial Title\nHello from typst.app cloud.\n"
    );
    const seedFiles = new Map<string, MockFileRecord>();
    seedFiles.set("file_1", {
      id: "file_1",
      name: "main.typ",
      isMultiplayable: true,
      yjsState: mainYjs,
      size: mainYjs.byteLength,
      version: 1,
      lastChangeDate: Date.now(),
    });
    projects.set("proj_seed", {
      id: "proj_seed",
      name: "Seed Research Paper",
      previewed: "file_1",
      pinnedVersion: "0.15.1",
      files: seedFiles,
    });

    server = Bun.serve<{ clientId: string; subscribedProject?: string }>({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);

        // WebSocket upgrade for /editing/v3
        if (url.pathname === "/editing/v3") {
          const clientId = url.searchParams.get("clientId") ?? "anon";
          if (srv.upgrade(req, { data: { clientId } })) {
            return undefined;
          }
          return new Response("Upgrade failed", { status: 400 });
        }

        // 1. Auth pre-signin cookie
        if (url.pathname === "/v1/to-signin" && req.method === "GET") {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${baseUrl}/signin/`,
              "Set-Cookie":
                "__Http-typst-session=preauth_token_123; Path=/; HttpOnly; Secure",
            },
          });
        }

        // 2. Auth password signin
        if (url.pathname === "/v1/auth/signin" && req.method === "POST") {
          if (blockDirectLoginWithChallenge) {
            return new Response("Turnstile challenge", {
              status: 403,
              headers: { Location: `${baseUrl}/signin/?challenge=1` },
            });
          }
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${baseUrl}/app`,
              "Set-Cookie":
                "__Http-typst-session=authenticated_session_xyz; Path=/; HttpOnly; Secure",
            },
          });
        }

        // Verify X-Typst-Preflight header on /v1/* API requests
        if (
          url.pathname.startsWith("/v1/") &&
          req.headers.get("X-Typst-Preflight") !== "true"
        ) {
          return Response.json(
            { code: ["MISSING_PREFLIGHT_HEADER"] },
            { status: 400 }
          );
        }

        // 3. GraphQL endpoint
        if (url.pathname === "/v1/graphql" && req.method === "POST") {
          return (async () => {
            const body = (await req.json()) as {
              query: string;
              variables: Record<string, any>;
            };
            const q = body.query;
            const vars = body.variables ?? {};

            if (q.includes("query DashboardContent")) {
              const list = [...projects.values()].map((p) => ({
                id: p.id,
                name: p.name,
                created: Date.now(),
                modified: Date.now(),
                owner: { id: "u_1", name: "Dang Duy Toan", avatar: null },
                access: { canWrite: true, canReview: true, canManage: true },
                folder: null,
              }));
              return Response.json({
                data: {
                  user: {
                    id: "u_1",
                    name: "Dang Duy Toan",
                    email: {
                      id: "e_1",
                      address: "student@swin.edu.au",
                      confirmed: true,
                    },
                    projects: list,
                    externalProjects: [],
                  },
                },
              });
            }

            if (q.includes("query ProjectFiles")) {
              const proj = projects.get(vars.projectId);
              if (!proj) {
                return Response.json({ data: { project: null } });
              }
              return Response.json({
                data: {
                  project: {
                    id: proj.id,
                    name: proj.name,
                    modified: Date.now(),
                    owner: { id: "u_1", name: "Dang Duy Toan", avatar: null },
                    access: {
                      canWrite: true,
                      canReview: true,
                      canManage: true,
                    },
                    previewed: proj.previewed,
                    pinnedVersion: proj.pinnedVersion,
                    files: [...proj.files.values()].map((f) => ({
                      id: f.id,
                      name: f.name,
                      isMultiplayable: f.isMultiplayable,
                      lastChange: { date: f.lastChangeDate },
                      size: f.size,
                      version: f.version,
                      magicKind: null,
                      etag: `"v${f.version}"`,
                    })),
                  },
                  user: {
                    id: "u_1",
                    name: "Dang Duy Toan",
                    email: { id: "e_1", address: "student@swin.edu.au" },
                  },
                },
              });
            }

            if (q.includes("mutation CreateProjectMutation")) {
              const id = `proj_${projects.size + 1}`;
              const filesMap = new Map<string, MockFileRecord>();
              const inputFiles: { name: string; content: string }[] =
                vars.files ?? [{ name: "main.typ", content: "" }];
              let idx = 1;
              for (const f of inputFiles) {
                const fid = `f_${id}_${idx++}`;
                const yjs = createInitialYjsUpdate(f.content);
                filesMap.set(fid, {
                  id: fid,
                  name: f.name,
                  isMultiplayable: true,
                  yjsState: yjs,
                  size: yjs.byteLength,
                  version: 1,
                  lastChangeDate: Date.now(),
                });
              }
              const firstFileId = [...filesMap.keys()][0] ?? null;
              projects.set(id, {
                id,
                name: vars.name,
                previewed: firstFileId,
                pinnedVersion: vars.pinnedVersion ?? "0.15.1",
                files: filesMap,
              });
              return Response.json({
                data: {
                  createProject: {
                    id,
                    name: vars.name,
                    created: Date.now(),
                    modified: Date.now(),
                    owner: { id: "u_1", name: "Dang Duy Toan", avatar: null },
                    access: {
                      canWrite: true,
                      canReview: true,
                      canManage: true,
                    },
                    folder: null,
                  },
                },
              });
            }

            if (q.includes("mutation DeleteProjectMutation")) {
              const existed = projects.delete(vars.id);
              return Response.json({ data: { deleteProject: existed } });
            }

            if (q.includes("mutation UpdatesFileMutation")) {
              const proj = projects.get(vars.projectId);
              if (!proj)
                return Response.json(
                  { errors: [{ message: "Project not found" }] },
                  { status: 404 }
                );
              const updated: { id: string; name: string }[] = [];
              for (const u of vars.updates) {
                const file = proj.files.get(u.id);
                if (file) {
                  file.name = u.fileName;
                  file.version += 1;
                  updated.push({ id: file.id, name: file.name });
                }
              }
              return Response.json({ data: { updateFiles: updated } });
            }

            if (q.includes("mutation DeleteFilesMutation")) {
              const proj = projects.get(vars.projectId);
              if (!proj)
                return Response.json(
                  { errors: [{ message: "Project not found" }] },
                  { status: 404 }
                );
              for (const id of vars.ids) {
                proj.files.delete(id);
              }
              return Response.json({ data: { deleteFiles: vars.ids } });
            }

            if (q.includes("mutation EditProject")) {
              const proj = projects.get(vars.projectId);
              if (!proj)
                return Response.json(
                  { errors: [{ message: "Project not found" }] },
                  { status: 404 }
                );
              if (vars.name) proj.name = vars.name;
              if (vars.previewed !== undefined) proj.previewed = vars.previewed;
              if (vars.pinnedVersion) proj.pinnedVersion = vars.pinnedVersion;
              return Response.json({
                data: {
                  updateProject: {
                    id: proj.id,
                    name: proj.name,
                    previewed: proj.previewed,
                    pinnedVersion: proj.pinnedVersion,
                  },
                },
              });
            }

            return Response.json(
              { errors: [{ message: "Unhandled GraphQL operation" }] },
              { status: 400 }
            );
          })();
        }

        // 4. REST Yjs file endpoints: /v1/files/:projectId/:fileId/yjs
        const yjsMatch = url.pathname.match(
          /^\/v1\/files\/([^/]+)\/([^/]+)\/yjs$/
        );
        if (yjsMatch) {
          const [, projectId, fileId] = yjsMatch;
          const proj = projects.get(projectId!);
          const file = proj?.files.get(fileId!);
          if (!file || !file.isMultiplayable) {
            return Response.json({ code: ["FILE_NOT_FOUND"] }, { status: 404 });
          }
          if (req.method === "GET") {
            return new Response(
              Buffer.from(file.yjsState ?? createInitialYjsUpdate("")),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/octet-stream",
                  Etag: `"v${file.version}"`,
                },
              }
            );
          }
          if (req.method === "PUT") {
            return (async () => {
              const incoming = new Uint8Array(await req.arrayBuffer());
              const doc = new Y.Doc();
              if (file.yjsState) Y.applyUpdate(doc, file.yjsState);
              Y.applyUpdate(doc, incoming);
              file.yjsState = Y.encodeStateAsUpdate(doc);
              file.size = file.yjsState.byteLength;
              file.version += 1;
              file.lastChangeDate = Date.now();
              doc.destroy();
              return new Response(null, { status: 200 });
            })();
          }
        }

        // 5. REST Blob / File replace or download: /v1/files/:projectId/:fileId
        const blobMatch = url.pathname.match(/^\/v1\/files\/([^/]+)\/([^/]+)$/);
        if (blobMatch) {
          const [, projectId, fileId] = blobMatch;
          const proj = projects.get(projectId!);
          const file = proj?.files.get(fileId!);
          if (!file) {
            return Response.json({ code: ["FILE_NOT_FOUND"] }, { status: 404 });
          }
          if (req.method === "GET") {
            return new Response(Buffer.from(file.blobBytes ?? new Uint8Array()), {
              status: 200,
              headers: { "Content-Type": "application/octet-stream" },
            });
          }
          if (req.method === "PUT") {
            return (async () => {
              const incoming = new Uint8Array(await req.arrayBuffer());
              file.blobBytes = incoming;
              file.size = incoming.byteLength;
              file.version += 1;
              file.lastChangeDate = Date.now();
              return Response.json({
                id: file.id,
                name: file.name,
                isMultiplayable: file.isMultiplayable,
                lastChange: { date: file.lastChangeDate },
                size: file.size,
                version: file.version,
                magicKind: null,
                etag: `"v${file.version}"`,
              });
            })();
          }
        }

        // 6. REST Create/Upload file: POST /v1/files/:projectId?name=...&convert=...
        const createFileMatch = url.pathname.match(/^\/v1\/files\/([^/]+)$/);
        if (createFileMatch && req.method === "POST") {
          return (async () => {
            const projectId = createFileMatch[1]!;
            const proj = projects.get(projectId);
            if (!proj) {
              return Response.json(
                { code: ["PROJECT_NOT_FOUND"] },
                { status: 404 }
              );
            }
            const name = url.searchParams.get("name") ?? "untitled.typ";
            const bytes = new Uint8Array(await req.arrayBuffer());
            const isText = /\.(typ|bib|toml|txt|md|csv|json|yaml|yml)$/i.test(
              name
            );
            const id = `file_${proj.files.size + 1}_${Date.now()}`;
            let yjsState: Uint8Array | undefined;
            let blobBytes: Uint8Array | undefined;
            if (isText) {
              yjsState = createInitialYjsUpdate(
                new TextDecoder().decode(bytes)
              );
            } else {
              blobBytes = bytes;
            }
            const record: MockFileRecord = {
              id,
              name,
              isMultiplayable: isText,
              yjsState,
              blobBytes,
              size: bytes.byteLength,
              version: 1,
              lastChangeDate: Date.now(),
            };
            proj.files.set(id, record);
            return Response.json([
              {
                id: record.id,
                name: record.name,
                isMultiplayable: record.isMultiplayable,
                lastChange: { date: record.lastChangeDate },
                size: record.size,
                version: record.version,
                magicKind: null,
                etag: `"v1"`,
              },
            ]);
          })();
        }

        return new Response("Not Found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          let bytes: Uint8Array;
          if (typeof message === "string") {
            bytes = new TextEncoder().encode(message);
          } else {
            bytes = new Uint8Array(message);
          }
          const decoded = decodeMessage(bytes, "client");
          if (decoded.kind === MessageKind.Subscribe) {
            ws.data.subscribedProject = decoded.rid;
            ws.send(
              encodeMessage({
                kind: MessageKind.Pong,
                traceparent: decoded.traceparent,
              })
            );
          } else if (decoded.kind === MessageKind.TextUpdate) {
            const projId = ws.data.subscribedProject;
            if (projId) {
              const proj = projects.get(projId);
              const file = proj?.files.get(decoded.fid);
              if (file && file.isMultiplayable) {
                const doc = new Y.Doc();
                if (file.yjsState) Y.applyUpdate(doc, file.yjsState);
                Y.applyUpdate(doc, decoded.encodedUpdate);
                file.yjsState = Y.encodeStateAsUpdate(doc);
                doc.destroy();
              }
              wsUpdateLog.push({
                projectId: projId,
                fileId: decoded.fid,
                traceparent: decoded.traceparent,
              });
            }
            ws.send(
              encodeMessage({
                kind: MessageKind.Pong,
                traceparent: decoded.traceparent,
              })
            );
          }
        },
      },
    });

    baseUrl = `http://127.0.0.1:${server.port}`;
    wsBaseUrl = `ws://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("exposes all 18 required MCP tools", () => {
    const names = TYPST_MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "typst_auth_login",
      "typst_auth_status",
      "typst_list_projects",
      "typst_get_project",
      "typst_create_project",
      "typst_delete_project",
      "typst_list_files",
      "typst_read_file",
      "typst_write_file",
      "typst_edit_file",
      "typst_upload_asset",
      "typst_delete_file",
      "typst_rename_file",
      "typst_get_diagnostics",
      "typst_export_pdf",
      "typst_capture_screenshot",
      "typst_grep_project",
      "typst_find_and_replace",
    ]);
  });

  test("authenticates via direct email/password API login and supports Turnstile/browser fallback", async () => {
    const sessionFile = join(tempDir, "session.json");
    const client = new TypstCloudClient({
      appUrl: baseUrl,
      apiUrl: baseUrl,
      wsUrl: wsBaseUrl,
      sessionFilePath: sessionFile,
      browserFallbackFn: async () => ({
        "__Http-typst-session": "browser_fallback_session_999",
      }),
    });

    // Direct API login
    const loginRes = (await dispatchTypstTool(client, "typst_auth_login", {
      email: "student@swin.edu.au",
      password: "secretPassword123",
    })) as any;
    expect(loginRes.authenticated).toBe(true);
    expect(loginRes.authMethod).toBe("api-password");

    const statusRes = (await dispatchTypstTool(
      client,
      "typst_auth_status",
      {}
    )) as any;
    expect(statusRes.authenticated).toBe(true);
    expect(statusRes.cookieNames).toContain("__Http-typst-session");

    // Simulate Turnstile 403 challenge -> automatic browser fallback
    blockDirectLoginWithChallenge = true;
    try {
      const fallbackRes = (await dispatchTypstTool(client, "typst_auth_login", {
        email: "student@swin.edu.au",
        password: "secretPassword123",
      })) as any;
      expect(fallbackRes.authenticated).toBe(true);
      expect(fallbackRes.authMethod).toBe("browser-fallback");
    } finally {
      blockDirectLoginWithChallenge = false;
    }
  });

  test("performs full project CRUD, Yjs file read/write/surgical edit over WebSocket+REST, asset upload, rename/delete, diagnostics, and PDF export", async () => {
    const client = new TypstCloudClient({
      appUrl: baseUrl,
      apiUrl: baseUrl,
      wsUrl: wsBaseUrl,
      sessionFilePath: null,
    });
    await dispatchTypstTool(client, "typst_auth_login", {
      email: "student@swin.edu.au",
      password: "secretPassword123",
    });

    // 1. List projects
    const listProj = (await dispatchTypstTool(
      client,
      "typst_list_projects"
    )) as any;
    expect(listProj.projects.length).toBeGreaterThanOrEqual(1);

    // 2. Create project
    const createdProj = (await dispatchTypstTool(
      client,
      "typst_create_project",
      {
        name: "AI Agent Typst Paper",
        files: [
          {
            name: "main.typ",
            content:
              "#set page(paper: \"a4\")\n\n= Agent Paper\nInitial draft text.\n",
          },
        ],
      }
    )) as any;
    expect(createdProj.id).toBeDefined();
    const projectId = createdProj.id;

    // 3. Get project & list files
    const projectDetail = (await dispatchTypstTool(
      client,
      "typst_get_project",
      { projectId }
    )) as any;
    expect(projectDetail.name).toBe("AI Agent Typst Paper");

    const files = (await dispatchTypstTool(client, "typst_list_files", {
      projectId,
    })) as any[];
    expect(files.length).toBe(1);
    expect(files[0].name).toBe("main.typ");

    // 4. Read Yjs text file
    const readMain = (await dispatchTypstTool(client, "typst_read_file", {
      projectId,
      filePath: "main.typ",
    })) as any;
    expect(readMain.content).toContain("Initial draft text.");

    // 5. Surgical edit on Yjs CRDT file (pushes over WebSocket /editing/v3 + REST)
    const editRes = (await dispatchTypstTool(client, "typst_edit_file", {
      projectId,
      filePath: "main.typ",
      edits: [
        {
          oldText: "Initial draft text.",
          newText: "Surgically updated text via Yjs CRDT and WebSocket v3.",
        },
      ],
    })) as any;
    expect(editRes.appliedCount).toBe(1);
    expect(editRes.syncChannel).toBe("websocket+rest");
    expect(wsUpdateLog.some((u) => u.projectId === projectId)).toBe(true);

    const readAfterEdit = (await dispatchTypstTool(client, "typst_read_file", {
      projectId,
      filePath: "main.typ",
    })) as any;
    expect(readAfterEdit.content).toContain(
      "Surgically updated text via Yjs CRDT and WebSocket v3."
    );

    // 6. Write new file (refs.bib)
    const writeBib = (await dispatchTypstTool(client, "typst_write_file", {
      projectId,
      filePath: "refs.bib",
      content: "@article{typst2023,\n  title={Typst},\n  author={Mädje, Laurenz},\n  year={2023}\n}\n",
    })) as any;
    expect(writeBib.created).toBe(true);

    // 7. Upload binary asset (1x1 transparent PNG)
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const uploadRes = (await dispatchTypstTool(client, "typst_upload_asset", {
      projectId,
      fileName: "figures/pixel.png",
      base64Data: pngBase64,
    })) as any;
    expect(uploadRes.file.name).toBe("figures/pixel.png");
    expect(uploadRes.replaced).toBe(false);

    // 8. Rename and delete a scratch file
    await dispatchTypstTool(client, "typst_write_file", {
      projectId,
      filePath: "scratch.typ",
      content: "// temp",
    });
    const renamed = (await dispatchTypstTool(client, "typst_rename_file", {
      projectId,
      filePath: "scratch.typ",
      newName: "notes.typ",
    })) as any;
    expect(renamed.name).toBe("notes.typ");

    const deletedFile = (await dispatchTypstTool(client, "typst_delete_file", {
      projectId,
      filePath: "notes.typ",
    })) as any;
    expect(deletedFile.name).toBe("notes.typ");

    // 9. Compiler diagnostics: introduce a deliberate syntax error, check diagnostics, then fix it
    await dispatchTypstTool(client, "typst_write_file", {
      projectId,
      filePath: "main.typ",
      content: "= Broken Heading\n#unknown_func_xyz(123)\n",
    });
    const badDiag = (await dispatchTypstTool(
      client,
      "typst_get_diagnostics",
      { projectId }
    )) as any;
    expect(badDiag.success).toBe(false);
    expect(badDiag.errorCount).toBeGreaterThan(0);
    expect(badDiag.diagnostics[0].severity).toBe("error");

    // Fix main.typ and compile clean
    await dispatchTypstTool(client, "typst_write_file", {
      projectId,
      filePath: "main.typ",
      content:
        "#set page(paper: \"a4\")\n\n= Verified Typst Document\nCompiled cleanly with figure:\n#image(\"figures/pixel.png\", width: 2cm)\n",
    });
    const cleanDiag = (await dispatchTypstTool(
      client,
      "typst_get_diagnostics",
      { projectId }
    )) as any;
    expect(cleanDiag.success).toBe(true);
    expect(cleanDiag.errorCount).toBe(0);

    // 10. Export PDF
    const outPdfPath = join(tempDir, "exported.pdf");
    const exportRes = (await dispatchTypstTool(client, "typst_export_pdf", {
      projectId,
      outputPath: outPdfPath,
    })) as any;
    expect(exportRes.pdfHeader).toStartWith("%PDF-");
    expect(exportRes.sizeBytes).toBeGreaterThan(500);
    expect(existsSync(outPdfPath)).toBe(true);

    // 11. Capture preview screenshot (PNG pages)
    const outPreviewDir = join(tempDir, "preview-shots");
    const screenshotRes = (await dispatchTypstTool(
      client,
      "typst_capture_screenshot",
      {
        projectId,
        outputDir: outPreviewDir,
        ppi: 144,
        includeBase64: true,
      }
    )) as any;
    expect(screenshotRes.pageCount).toBeGreaterThanOrEqual(1);
    expect(screenshotRes.screenshots[0].pngSignatureValid).toBe(true);
    expect(screenshotRes.screenshots[0].sizeBytes).toBeGreaterThan(500);
    expect(typeof screenshotRes.screenshots[0].base64).toBe("string");
    expect(existsSync(screenshotRes.screenshots[0].path)).toBe(true);

    // 12. Delete project
    const delProj = (await dispatchTypstTool(client, "typst_delete_project", {
      projectId,
    })) as any;
    expect(delProj.deleted).toBe(true);
  }, 20000);

  test("spawns MCP server over JSON-RPC stdio and responds to initialize and tools/list", async () => {
    const proc = Bun.spawn(["bun", join(repoRoot, "src/index.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const requests = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    ].join("\n") + "\n";

    proc.stdin.write(requests);
    proc.stdin.end();

    const stdoutText = await new Response(proc.stdout).text();
    const lines = stdoutText
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const initReply = lines.find((m) => m.id === 1);
    expect(initReply?.result?.serverInfo?.name).toBe("typst-mcp");

    const toolsReply = lines.find((m) => m.id === 2);
    expect(toolsReply?.result?.tools?.length).toBe(18);
    proc.kill();
  });

  test("verifies live https://api.typst.app pre-signin cookie handshake and GraphQL preflight header acceptance", async () => {
    const liveClient = new TypstCloudClient({ sessionFilePath: null });
    const gqlRes = await liveClient.graphql<{ countryCode: string | null }>(
      "query GetCountryCode { countryCode }"
    );
    expect("countryCode" in gqlRes).toBe(true);

    const toSigninRes = await fetch("https://api.typst.app/v1/to-signin", {
      redirect: "manual",
    });
    expect(toSigninRes.status).toBe(302);
    expect(toSigninRes.headers.get("set-cookie")).toContain(
      "__Http-typst-session="
    );
  });

  test("offsetToPosition accurately maps byte offset to line and column", () => {
    const text = "= Title\n\n#let x = 1\n#test(x)\n";
    expect(offsetToPosition(text, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition(text, 8)).toEqual({ line: 2, column: 1 });
    expect(offsetToPosition(text, 9)).toEqual({ line: 3, column: 1 });
    expect(offsetToPosition(text, 14)).toEqual({ line: 3, column: 6 });
  });

  test("hasTypstBinary checks presence of typst binary", () => {
    const available = hasTypstBinary();
    expect(typeof available).toBe("boolean");
  });

  test("resolvePythonBinary resolves an available python executable", () => {
    const py = resolvePythonBinary();
    expect(typeof py).toBe("string");
  });
});
