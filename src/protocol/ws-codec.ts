import {
  Encoder,
  writeUint8,
  writeVarUint,
  writeVarString,
  writeVarUint8Array,
  toUint8Array,
} from "lib0/encoding";
import {
  Decoder,
  readUint8,
  readVarUint,
  readVarString,
  readVarUint8Array,
} from "lib0/decoding";

export enum MessageKind {
  Error = 0,
  Pong = 1,
  Subscribe = 2,
  Unsubscribe = 3,
  Refresh = 4,
  TextUpdate = 5,
  Presence = 6,
  Cursor = 7,
  Leave = 8,
}

export enum RefreshDomain {
  File = 0,
  Project = 1,
  Comment = 2,
}

export enum RefreshAction {
  Create = 0,
  Update = 1,
  Delete = 2,
}

export interface RelativePosition {
  client: number;
  clock: number;
}

export interface CursorPosition {
  anchor: RelativePosition;
  head: RelativePosition;
}

export interface TraceContext {
  traceparent?: string;
  tracestate?: string;
}

export type TypstWsMessage = TraceContext &
  (
    | { kind: MessageKind.Error; issues: string[] }
    | { kind: MessageKind.Pong }
    | { kind: MessageKind.Subscribe; rid: string; from: string }
    | { kind: MessageKind.Unsubscribe; pid: string }
    | {
        kind: MessageKind.Refresh;
        domain: RefreshDomain;
        action: RefreshAction;
        ids: string[];
      }
    | { kind: MessageKind.TextUpdate; fid: string; encodedUpdate: Uint8Array }
    | {
        kind: MessageKind.Presence;
        peerId: string;
        uid: string | null;
        name: string | null;
        avatar: boolean;
        presenting: boolean;
        activeFile: string | null;
      }
    | {
        kind: MessageKind.Cursor;
        peerId: string;
        cursor: CursorPosition | null;
      }
    | { kind: MessageKind.Leave; peerId: string }
  );

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class ProtocolParseError extends ProtocolError {
  override cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProtocolParseError";
    this.cause = cause;
  }
}

export class ProtocolEnumerationError extends ProtocolError {
  enumName: string;
  value: number;
  constructor(enumName: string, value: number) {
    super(`Unknown value ${value} in enumeration ${enumName}`);
    this.name = "ProtocolEnumerationError";
    this.enumName = enumName;
    this.value = value;
  }
}

export class ProtocolDirectionalityError extends ProtocolError {
  origin: "client" | "server";
  received: number;
  constructor(origin: "client" | "server", received: number) {
    super(`Unexpected message kind ${received} received from ${origin}`);
    this.name = "ProtocolDirectionalityError";
    this.origin = origin;
    this.received = received;
  }
}

export function isClientMessageKind(kind: number): boolean {
  switch (kind) {
    case MessageKind.Subscribe:
    case MessageKind.Unsubscribe:
    case MessageKind.TextUpdate:
    case MessageKind.Presence:
    case MessageKind.Cursor:
      return true;
    case MessageKind.Error:
    case MessageKind.Pong:
    case MessageKind.Refresh:
    case MessageKind.Leave:
      return false;
    default:
      throw new ProtocolEnumerationError("MessageKind", kind);
  }
}

export function isServerMessageKind(kind: number): boolean {
  switch (kind) {
    case MessageKind.Error:
    case MessageKind.Pong:
    case MessageKind.Refresh:
    case MessageKind.TextUpdate:
    case MessageKind.Presence:
    case MessageKind.Cursor:
    case MessageKind.Leave:
      return true;
    case MessageKind.Subscribe:
    case MessageKind.Unsubscribe:
      return false;
    default:
      throw new ProtocolEnumerationError("MessageKind", kind);
  }
}

function isRefreshDomain(val: number): val is RefreshDomain {
  return (
    val === RefreshDomain.File ||
    val === RefreshDomain.Project ||
    val === RefreshDomain.Comment
  );
}

function isRefreshAction(val: number): val is RefreshAction {
  return (
    val === RefreshAction.Create ||
    val === RefreshAction.Update ||
    val === RefreshAction.Delete
  );
}

function decodeOptionalString(decoder: Decoder): string | null {
  const s = readVarString(decoder);
  return s === "" ? null : s;
}

function encodeOptionalString(encoder: Encoder, value: string | null | undefined): void {
  writeVarString(encoder, value ?? "");
}

function decodeBoolean(decoder: Decoder): boolean {
  return readUint8(decoder) !== 0;
}

function encodeBoolean(encoder: Encoder, value: boolean): void {
  writeUint8(encoder, value ? 1 : 0);
}

function decodeRelativePosition(decoder: Decoder): RelativePosition {
  return {
    client: readVarUint(decoder),
    clock: readVarUint(decoder),
  };
}

function encodeRelativePosition(encoder: Encoder, pos: RelativePosition): void {
  writeVarUint(encoder, pos.client);
  writeVarUint(encoder, pos.clock);
}

export function encodeMessage(msg: TypstWsMessage): Uint8Array {
  const encoder = new Encoder();
  writeUint8(encoder, msg.kind);

  if (msg.traceparent === undefined) {
    encodeBoolean(encoder, false);
  } else {
    encodeBoolean(encoder, true);
    writeVarString(encoder, msg.traceparent);
    encodeOptionalString(encoder, msg.tracestate ?? null);
  }

  switch (msg.kind) {
    case MessageKind.Error:
      writeVarUint(encoder, msg.issues.length);
      for (const issue of msg.issues) {
        writeVarString(encoder, issue);
      }
      break;
    case MessageKind.Pong:
      break;
    case MessageKind.Subscribe:
      writeVarString(encoder, msg.rid);
      writeVarString(encoder, msg.from);
      break;
    case MessageKind.Unsubscribe:
      writeVarString(encoder, msg.pid);
      break;
    case MessageKind.TextUpdate:
      writeVarString(encoder, msg.fid);
      writeVarUint8Array(encoder, msg.encodedUpdate);
      break;
    case MessageKind.Presence:
      writeUint8(encoder, Number(msg.avatar) | (Number(msg.presenting) << 1));
      writeVarString(encoder, msg.peerId);
      encodeOptionalString(encoder, msg.uid);
      encodeOptionalString(encoder, msg.name);
      encodeOptionalString(encoder, msg.activeFile);
      break;
    case MessageKind.Cursor:
      writeVarString(encoder, msg.peerId);
      if (msg.cursor === null) {
        writeUint8(encoder, 0);
      } else {
        const { anchor, head } = msg.cursor;
        if (anchor.client === head.client && anchor.clock === head.clock) {
          writeUint8(encoder, 1);
          encodeRelativePosition(encoder, anchor);
        } else {
          writeUint8(encoder, 2);
          encodeRelativePosition(encoder, anchor);
          encodeRelativePosition(encoder, head);
        }
      }
      break;
    case MessageKind.Leave:
      writeVarString(encoder, msg.peerId);
      break;
    case MessageKind.Refresh:
      writeUint8(encoder, msg.domain);
      writeUint8(encoder, msg.action);
      writeVarUint(encoder, msg.ids.length);
      for (const id of msg.ids) {
        writeVarString(encoder, id);
      }
      break;
  }

  return toUint8Array(encoder);
}

export function decodeMessage(
  bytes: Uint8Array,
  origin?: "client" | "server"
): TypstWsMessage {
  try {
    const decoder = new Decoder(bytes);
    const kind = readUint8(decoder);
    if (origin === "client" && !isClientMessageKind(kind)) {
      throw new ProtocolDirectionalityError(origin, kind);
    }
    if (origin === "server" && !isServerMessageKind(kind)) {
      throw new ProtocolDirectionalityError(origin, kind);
    }

    const hasTrace = decodeBoolean(decoder);
    const trace: TraceContext = {};
    if (hasTrace) {
      trace.traceparent = readVarString(decoder);
      trace.tracestate = decodeOptionalString(decoder) ?? undefined;
    }

    switch (kind) {
      case MessageKind.Error: {
        const len = readVarUint(decoder);
        const issues: string[] = [];
        for (let i = 0; i < len; i++) {
          issues.push(readVarString(decoder));
        }
        return { kind, issues, ...trace };
      }
      case MessageKind.Pong:
        return { kind, ...trace };
      case MessageKind.Subscribe:
        return {
          kind,
          rid: readVarString(decoder),
          from: readVarString(decoder),
          ...trace,
        };
      case MessageKind.Unsubscribe:
        return {
          kind,
          pid: readVarString(decoder),
          ...trace,
        };
      case MessageKind.TextUpdate:
        return {
          kind,
          fid: readVarString(decoder),
          encodedUpdate: readVarUint8Array(decoder),
          ...trace,
        };
      case MessageKind.Presence: {
        const flags = readUint8(decoder);
        const avatar = (flags & 1) !== 0;
        const presenting = (flags & 2) !== 0;
        return {
          kind,
          peerId: readVarString(decoder),
          uid: decodeOptionalString(decoder),
          name: decodeOptionalString(decoder),
          avatar,
          presenting,
          activeFile: decodeOptionalString(decoder),
          ...trace,
        };
      }
      case MessageKind.Cursor: {
        const peerId = readVarString(decoder);
        const mode = readUint8(decoder);
        let cursor: CursorPosition | null = null;
        if (mode === 1) {
          const pos = decodeRelativePosition(decoder);
          cursor = { anchor: pos, head: pos };
        } else if (mode === 2) {
          cursor = {
            anchor: decodeRelativePosition(decoder),
            head: decodeRelativePosition(decoder),
          };
        }
        return { kind, peerId, cursor, ...trace };
      }
      case MessageKind.Leave:
        return { kind, peerId: readVarString(decoder), ...trace };
      case MessageKind.Refresh: {
        const domain = readUint8(decoder);
        if (!isRefreshDomain(domain)) {
          throw new ProtocolEnumerationError("RefreshDomain", domain);
        }
        const action = readUint8(decoder);
        if (!isRefreshAction(action)) {
          throw new ProtocolEnumerationError("RefreshAction", action);
        }
        const len = readVarUint(decoder);
        const ids: string[] = [];
        for (let i = 0; i < len; i++) {
          ids.push(readVarString(decoder));
        }
        return { kind, domain, action, ids, ...trace };
      }
      default:
        throw new ProtocolEnumerationError("MessageKind", kind);
    }
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolParseError("Failed to decode message", err);
  }
}
