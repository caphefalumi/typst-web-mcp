# Typst Web Application (`https://typst.app/`) Reverse-Engineered Protocol Specification

This document details the client-server architecture, authentication mechanism, GraphQL schema, REST file/CRDT endpoints, binary WebSocket (`/editing/v3`) wire protocol, and client compiler pipeline reverse-engineered from `https://typst.app/` (`index-CQxQbVQ1.js`, `SigninPage.astro_astro_type_script_index_0_lang.CJRgYGDA.js`, and `https://api.typst.app`).

---

## 1. Host & Endpoint Architecture

`HostConfiguration` in the web bundle defines the following production hosts:

| Component | URL / Endpoint | Purpose |
|:---|:---|:---|
| **Web App (`APP_URL`)** | `https://typst.app` | Astro marketing/auth pages (`/signin/`, `/signup/`) and React editor SPA (`/app`, `/project/:id`) |
| **Core API (`API_URL`)** | `https://api.typst.app` | REST `/v1/*` and GraphQL `/v1/graphql` backend |
| **Editing WebSocket** | `wss://api.typst.app/editing/v3?clientId=<8-char-nanoid>` | Real-time Yjs CRDT synchronization, presence, cursors, and entity refresh push notifications |
| **Public Packages** | `https://packages.typst.org/preview/index.json` | Typst Universe package index and tarballs (`/preview/{name}-{version}.tar.gz`) |
| **Private/Scoped Packages** | `https://api.typst.app/v1/package/local/index.json?context={teamOrUserId}` | Private/team package registry |

---

## 2. Authentication & Session Cookies

### 2.1 Cookie Names (`COOKIE_BASE_NAME`)
In production (`DEBUG = false`), `unwrapCookieName` prefixes cookies with `__Http-` (when `httpOnly: true, secureName: true`) or `__Secure-`:

| Logical Key | Production Cookie Name | Flags | Purpose |
|:---|:---|:---|:---|
| `SESSION` | `__Http-typst-session` | `HttpOnly; Secure; SameSite=Lax; Domain=typst.app; Path=/` | Primary authenticated session token |
| `SESSION_LAX` | `__Http-typst-session-lax` | `HttpOnly; Secure; SameSite=Lax; Domain=typst.app; Path=/` | Lax session companion cookie |
| `INDICATOR` | `INSECURE_SIGNED_IN` | `Secure; SameSite=Lax; Domain=typst.app; Path=/` | Non-HttpOnly indicator read by frontend JS (`isInsecureSignedIn()`) |
| `OIDC_NONCE` | `__Http-oidc-nonce` | `HttpOnly; Secure` | OIDC authentication state nonce |

### 2.2 Direct Email & Password Sign-In Flow
1. **Initialize Pre-Auth Session Cookie:**
   - Request: `GET https://api.typst.app/v1/to-signin`
   - Response: `302 Found` -> `Location: https://typst.app/signin/`
   - Sets initial `Set-Cookie: __Http-typst-session=<pre_auth_token>; Domain=typst.app; Path=/; HttpOnly; Secure; SameSite=Lax`.
2. **Submit Credentials (`application/x-www-form-urlencoded`):**
   - Form parsed from `https://typst.app/signin/` and `https://typst.app/signin/with-password/`:
   - Request: `POST https://api.typst.app/v1/auth/signin`
   - Headers:
     - `Content-Type: application/x-www-form-urlencoded`
     - `Cookie: __Http-typst-session=<pre_auth_token>`
     - `Origin: https://typst.app`
     - `Referer: https://typst.app/signin/`
   - Form Body:
     - `email`: User email address
     - `password`: User password
     - `redirect`: `""` (or target path after sign-in)
     - `grant-id`: `""`
     - `captcha-trap`: `""` (honeypot input `input[name="captcha-trap"]`; must remain empty)
   - Response: `302 Found` or `303 See Other` issuing updated `__Http-typst-session`, `__Http-typst-session-lax`, and `INSECURE_SIGNED_IN` cookies.
3. **Logout Endpoints:**
   - Current session: `GET https://api.typst.app/v1/auth/logout`
   - All sessions: `GET https://api.typst.app/v1/auth/logout?all=true`

---

## 3. REST API (`RestClient` — `https://api.typst.app/v1/*`)

### 3.1 Required Request Headers
Every REST and GraphQL request attaches:
- `X-Typst-Preflight: true` (CSRF preflight enforcement header required on `/v1/*` requests unless explicitly disabled)
- `X-Typst-Client-Id: <clientId>` (8-character `nanoid` identifying the editor session)
- `Cookie: __Http-typst-session=...`

### 3.2 REST Endpoints
| Method | Path | Query Params | Body | Response | Description |
|:---|:---|:---|:---|:---|:---|
| `GET` | `/v1/files/:projectId/:fileId/yjs` | — | — | `application/octet-stream` (`Uint8Array`) | Downloads binary Yjs CRDT state vector/update for a multiplayer text file (`isMultiplayable: true`). |
| `PUT` | `/v1/files/:projectId/:fileId/yjs` | — | `Uint8Array` (Yjs update) | `200 OK` | Saves incremental or state-diff Yjs CRDT update for a multiplayer text file (`saveLocalUpdatesViaApi`). |
| `GET` | `/v1/files/:projectId/:fileId` | — | — | Binary bytes (`Uint8Array`) | Downloads raw bytes of a binary/blob file (`isMultiplayable: false`, e.g., PNG, JPG, PDF, SVG). |
| `PUT` | `/v1/files/:projectId/:fileId` | — | Raw file bytes | `CoreFileFields` JSON | Replaces content of an existing binary/blob file. |
| `POST` | `/v1/files/:projectId` | `name=<path>&convert=<bool>` | Raw file bytes | `CoreFileFields` JSON | Creates/uploads a new file (text or binary asset) in the project. |
| `POST` | `/v1/projects/:projectId/thumb/:hash` | — | `image/png` | `200 OK` | Uploads compiled project thumbnail PNG. |
| `GET` | `/v1/data_takeout` | — | — | Archive stream | Exports user data takeout archive. |

### 3.3 Error Format (`LoadError`)
Non-2xx JSON responses return:
```json
{
  "code": ["FILE_NOT_FOUND"],
  "message": "Optional human-readable detail",
  "userFacingUrl": "Optional URL"
}
```
HTTP status mappings when body is not JSON: `404 -> FILE_NOT_FOUND`, `413 -> FILE_TOO_LARGE`, `429 -> RATE_LIMIT_EXCEEDED`, `503 -> TEMPORARILY_UNAVAILABLE`.

---

## 4. Yjs CRDT Text Document Model

All editable text files in `typst.app` (`.typ`, `.bib`, `.toml`, `.txt`, `.md`, `.csv`, `.json`, `.yaml`, etc.) have `isMultiplayable: true` in GraphQL metadata.

1. **Shared Type Structure:**
   - Each multiplayer file is backed by a `Y.Doc` (`yjs`) containing a single `Y.Text` key named `"text"`:
     ```ts
     const doc = new Y.Doc();
     Y.applyUpdate(doc, remoteYjsBytes);
     const textContent = doc.getText("text").toString();
     ```
2. **Computing & Persisting Local Edits:**
   - Given the remote baseline `remoteYjsBytes` (`Uint8Array` from `GET /v1/files/:projectId/:fileId/yjs`):
     ```ts
     const doc = new Y.Doc();
     Y.applyUpdate(doc, remoteYjsBytes);
     const ytext = doc.getText("text");
     doc.transact(() => {
       ytext.delete(startIndex, deleteCount);
       ytext.insert(startIndex, insertText);
     });
     const stateVector = Y.encodeStateVectorFromUpdate(remoteYjsBytes);
     const diffUpdate = Y.encodeStateAsUpdate(doc, stateVector);
     ```
   - The `diffUpdate` (`Uint8Array`) can be persisted immediately via `PUT /v1/files/:projectId/:fileId/yjs` or streamed live over WebSocket via `MessageKind.TextUpdate (5)`.

---

## 5. GraphQL API (`POST https://api.typst.app/v1/graphql`)

### 5.1 Core Queries & Mutations
1. **List User & Dashboard Projects (`DashboardContent`):**
   ```graphql
   query DashboardContent {
     user {
       id
       name
       email { id address confirmed }
       projects {
         id name created modified
         owner { id name avatar }
         access { canWrite canReview canManage }
         folder { id }
       }
       externalProjects {
         id name created modified
         owner { id name avatar }
         access { canWrite canReview canManage }
       }
     }
   }
   ```
2. **Fetch Project Metadata & Files (`ProjectFiles`):**
   ```graphql
   query ProjectFiles($projectId: ID!) {
     project(id: $projectId) {
       id name modified previewed pinnedVersion settings
       access { canReview canWrite canManage }
       files {
         id name isMultiplayable size version magicKind etag
         lastChange { date }
       }
     }
   }
   ```
3. **Create Project (`CreateProjectMutation`):**
   ```graphql
   mutation CreateProjectMutation(
     $name: String!
     $owner: ID
     $files: [NewTypstFile!]
     $pinnedVersion: String
   ) {
     createProject(name: $name, owner: $owner, files: $files, pinnedVersion: $pinnedVersion) {
       id name created modified
     }
   }
   ```
   where `NewTypstFile` is `{ name: String!, content: String! }`.
4. **Update Project (`EditProject`):**
   ```graphql
   mutation EditProject($projectId: ID!, $name: String, $previewed: ID, $pinnedVersion: String) {
     updateProject(id: $projectId, name: $name, previewed: $previewed, pinnedVersion: $pinnedVersion) {
       id name previewed pinnedVersion
     }
   }
   ```
5. **Delete Project (`DeleteProjectMutation`):**
   ```graphql
   mutation DeleteProjectMutation($id: ID!) {
     deleteProject(id: $id)
   }
   ```
6. **Rename / Move Files (`UpdatesFileMutation`):**
   ```graphql
   mutation UpdatesFileMutation($projectId: ID!, $updates: [FileUpdate!]!) {
     updateFiles(projectId: $projectId, updates: $updates) {
       id name
     }
   }
   ```
   where `FileUpdate` is `{ id: ID!, fileName: String! }`.
7. **Delete Files (`DeleteFilesMutation`):**
   ```graphql
   mutation DeleteFilesMutation($projectId: ID!, $ids: [ID!]!) {
     deleteFiles(projectId: $projectId, ids: $ids)
   }
   ```

---

## 6. Binary WebSocket Protocol (`wss://api.typst.app/editing/v3?clientId=<id>`)

The WebSocket uses binary frames (`binaryType = "arraybuffer"`) encoded with `lib0/encoding` and `lib0/decoding` (`writeUint8`, `writeVarUint`, `writeVarString`, `writeVarUint8Array`).

### 6.1 Frame Header
Every client and server message begins with:
1. `kind: uint8` (`MessageKind`)
2. `hasTraceContext: uint8` (`0` = false, `1` = true)
   - If `hasTraceContext === 1`:
     - `traceparent: varString` (used as update correlation ID for `TextUpdate` -> `Pong` acknowledgment, or `"subscribe"` on initial `Subscribe`)
     - `tracestate: varString` (`""` when null/omitted)

### 6.2 `MessageKind` Enumeration & Payloads

| `MessageKind` | ID | Direction | Payload Fields (after Frame Header) |
|:---|:---:|:---:|:---|
| `Error` | `0` | Server -> Client | `count: varUint`, followed by `count` × `issue: varString` (e.g. `PROJECT_NOT_FOUND`, `FILE_HISTORY_TOO_LARGE`) |
| `Pong` | `1` | Server -> Client | *(empty body)* — acknowledges client message matching `traceparent` |
| `Subscribe` | `2` | Client -> Server | `rid: varString` (`projectToken`/`projectId`), `from: varString` (`"0"`) |
| `Unsubscribe` | `3` | Client -> Server | `pid: varString` (`projectId`) |
| `Refresh` | `4` | Server -> Client | `domain: uint8` (`0=File, 1=Project, 2=Comment`), `action: uint8` (`0=Create, 1=Update, 2=Delete`), `ids: varUint count + varString[]` |
| `TextUpdate` | `5` | Bidirectional | `fid: varString` (`fileId`), `encodedUpdate: varUint8Array` (Yjs binary update) |
| `Presence` | `6` | Bidirectional | `flags: uint8` (`bit0=avatar, bit1=presenting`), `peerId: varString`, `uid: optionalVarString`, `name: optionalVarString`, `activeFile: optionalVarString` |
| `Cursor` | `7` | Bidirectional | `peerId: varString`, `mode: uint8` (`0=null`, `1=anchor(client:varUint, clock:varUint)`, `2=anchor+head`) |
| `Leave` | `8` | Server -> Client | `peerId: varString` |

---

## 7. Compiler & Diagnostics Architecture

In the browser client, `typst.app` executes compilation inside a multi-threaded `SharedArrayBuffer` WebWorker pool (`CompilerContext` -> `Core` -> `Handler`) running WebAssembly builds of the Typst compiler (`0.10.0` through `0.15.1`, e.g., `/assets/core_bg-w9ivCOeS.wasm`):
- Multiplayer files (`doc.getText("text").toString()`) and binary blobs are registered via `core.create(path, mime, data)` and `core.setMain(mainFilePath)`.
- Compiler diagnostics are emitted via `onDiagnostics` as objects `{ path, package, range: { start, end }, severity: "error" | "warning", message, hints: string[] }`.
- PDF export is executed via `core.export({ format: "pdf", standards: [], tagged: true, pretty: false })`.
- In `typst-mcp`, project files (both decoded Yjs text files and binary assets) are synchronized from `typst.app` into a workspace and compiled via the Typst compiler (`typst compile`) to produce structured diagnostics and PDF exports.
