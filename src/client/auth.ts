import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface StoredSession {
  cookies: Record<string, string>;
  email?: string;
  authMethod: "api-password" | "cookie" | "browser-fallback";
  updatedAt: string;
}

export interface AuthLoginOptions {
  email?: string;
  password?: string;
  sessionCookie?: string;
  useBrowserFallback?: boolean;
}

export type BrowserLoginFallbackFn = (
  appUrl: string,
  apiUrl: string,
  email: string,
  password: string
) => Promise<Record<string, string>>;

export interface AuthManagerOptions {
  appUrl?: string;
  apiUrl?: string;
  sessionFilePath?: string | null;
  fetchImpl?: typeof fetch;
  browserFallbackFn?: BrowserLoginFallbackFn;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function extractRawSetCookies(headers: Headers): string[] {
  const headerWithGetSetCookie = headers as unknown as {
    getSetCookie?: () => string[];
  };
  if (typeof headerWithGetSetCookie.getSetCookie === "function") {
    return headerWithGetSetCookie.getSetCookie();
  }
  const singleCookie = headers.get("set-cookie");
  if (singleCookie) {
    return [singleCookie];
  }
  return [];
}

export function getDefaultSessionFilePath(): string {
  if (process.env.TYPST_SESSION_FILE) {
    return process.env.TYPST_SESSION_FILE;
  }

  const platform = process.platform;
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ||
      (process.env.APPDATA
        ? join(process.env.APPDATA, "..", "Local")
        : join(homedir(), "AppData", "Local"));
    return join(localAppData, "typst-mcp", "session.json");
  }

  if (platform === "darwin") {
    if (process.env.XDG_CACHE_HOME) {
      return join(process.env.XDG_CACHE_HOME, "typst-mcp", "session.json");
    }
    return join(homedir(), "Library", "Caches", "typst-mcp", "session.json");
  }

  // Linux and other POSIX systems (XDG Base Directory specification)
  const cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheDir, "typst-mcp", "session.json");
}

function resolveSessionFilePath(
  configuredPath: string | null | undefined
): string | null {
  if (configuredPath === undefined) {
    return getDefaultSessionFilePath();
  }
  return configuredPath;
}

export function parseSetCookieHeaders(
  headers: Headers
): Record<string, string> {
  const result: Record<string, string> = {};
  const rawList = extractRawSetCookies(headers);

  for (const raw of rawList) {
    const firstPart = raw.split(";")[0]?.trim();
    if (!firstPart) {
      continue;
    }
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const name = firstPart.slice(0, eqIdx).trim();
    const val = firstPart.slice(eqIdx + 1).trim();
    if (val === "") {
      delete result[name];
    } else {
      result[name] = val;
    }
  }
  return result;
}

export function parseCookieString(cookieStr: string): Record<string, string> {
  const trimmed = cookieStr.trim();
  if (!trimmed) {
    return {};
  }
  if (!trimmed.includes("=")) {
    return { "__Http-typst-session": trimmed };
  }
  const map: Record<string, string> = {};
  for (const part of trimmed.split(";")) {
    const p = part.trim();
    if (!p) {
      continue;
    }
    const eq = p.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k && v) {
      map[k] = v;
    }
  }
  return map;
}

export class TypstAuthManager {
  readonly appUrl: string;
  readonly apiUrl: string;
  readonly sessionFilePath: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly browserFallbackFn?: BrowserLoginFallbackFn;
  private cookies: Record<string, string> = {};
  private authMethod: StoredSession["authMethod"] | null = null;
  private email?: string;

  constructor(options: AuthManagerOptions = {}) {
    const rawAppUrl =
      options.appUrl ?? process.env.TYPST_APP_URL ?? "https://typst.app";
    const rawApiUrl =
      options.apiUrl ?? process.env.TYPST_API_URL ?? "https://api.typst.app";

    this.appUrl = rawAppUrl.replace(/\/+$/, "");
    this.apiUrl = rawApiUrl.replace(/\/+$/, "");
    this.sessionFilePath = resolveSessionFilePath(options.sessionFilePath);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.browserFallbackFn = options.browserFallbackFn;

    this.loadStoredSession();
    if (
      Object.keys(this.cookies).length === 0 &&
      process.env.TYPST_SESSION_COOKIE
    ) {
      this.setSessionCookie(process.env.TYPST_SESSION_COOKIE);
    }
  }

  private loadStoredSession(): void {
    if (!this.sessionFilePath) {
      return;
    }
    let targetPath = this.sessionFilePath;
    if (!existsSync(targetPath)) {
      // Legacy fallback check for seamless migration from ~/.pi/agent/typst-mcp-session.json
      const legacyPath = join(homedir(), ".pi", "agent", "typst-mcp-session.json");
      if (existsSync(legacyPath)) {
        targetPath = legacyPath;
      } else {
        return;
      }
    }
    try {
      const raw = JSON.parse(
        readFileSync(targetPath, "utf8")
      ) as StoredSession;
      if (raw && typeof raw.cookies === "object" && raw.cookies) {
        this.cookies = { ...raw.cookies };
        this.authMethod = raw.authMethod ?? "cookie";
        this.email = raw.email;
      }
    } catch {
      // Ignore corrupted session file
    }
  }

  private saveStoredSession(): void {
    if (!this.sessionFilePath) {
      return;
    }
    try {
      mkdirSync(dirname(this.sessionFilePath), { recursive: true });
      const payload: StoredSession = {
        cookies: this.cookies,
        email: this.email,
        authMethod: this.authMethod ?? "cookie",
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(
        this.sessionFilePath,
        JSON.stringify(payload, null, 2),
        "utf8"
      );
    } catch {
      // Non-fatal if filesystem is read-only
    }
  }

  setSessionCookie(cookieInput: string, email?: string): void {
    const parsed = parseCookieString(cookieInput);
    this.cookies = { ...this.cookies, ...parsed };
    this.authMethod = "cookie";
    if (email) {
      this.email = email;
    }
    this.saveStoredSession();
  }

  getCookieHeader(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  hasSession(): boolean {
    return Boolean(
      this.cookies["__Http-typst-session"] ||
        this.cookies["typst-session"] ||
        this.cookies["session"]
    );
  }

  getStatus(): {
    authenticated: boolean;
    authMethod: string | null;
    email?: string;
    cookieNames: string[];
  } {
    return {
      authenticated: this.hasSession(),
      authMethod: this.authMethod,
      email: this.email,
      cookieNames: Object.keys(this.cookies),
    };
  }

  async login(options: AuthLoginOptions = {}): Promise<{
    authenticated: boolean;
    authMethod: "api-password" | "cookie" | "browser-fallback";
    email?: string;
    cookieNames: string[];
  }> {
    const sessionCookie =
      options.sessionCookie ?? process.env.TYPST_SESSION_COOKIE;
    const email = options.email ?? process.env.TYPST_EMAIL;
    const password = options.password ?? process.env.TYPST_PASSWORD;

    if (sessionCookie && (!email || !password)) {
      this.setSessionCookie(sessionCookie, email);
      return {
        authenticated: this.hasSession(),
        authMethod: "cookie",
        email: this.email,
        cookieNames: Object.keys(this.cookies),
      };
    }

    if (!email || !password) {
      if (sessionCookie) {
        this.setSessionCookie(sessionCookie, email);
        return {
          authenticated: this.hasSession(),
          authMethod: "cookie",
          email: this.email,
          cookieNames: Object.keys(this.cookies),
        };
      }
      throw new Error(
        "Missing credentials: provide email & password (or TYPST_EMAIL / TYPST_PASSWORD), or sessionCookie (TYPST_SESSION_COOKIE)."
      );
    }

    // Step 1: Initialize pre-auth session cookie via GET /v1/to-signin
    const initRes = await this.fetchImpl(`${this.apiUrl}/v1/to-signin`, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
      },
    });

    const preAuthCookies = parseSetCookieHeaders(initRes.headers);
    const mergedCookies: Record<string, string> = {
      ...this.cookies,
      ...preAuthCookies,
    };

    const cookieHeader = Object.entries(mergedCookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    // Step 2: Submit credentials to POST /v1/auth/signin
    const form = new URLSearchParams();
    form.set("email", email);
    form.set("password", password);
    form.set("redirect", "");
    form.set("grant-id", "");
    form.set("captcha-trap", ""); // Honeypot field must remain empty

    const signinRes = await this.fetchImpl(`${this.apiUrl}/v1/auth/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        Origin: this.appUrl,
        Referer: `${this.appUrl}/signin/`,
        "User-Agent": DEFAULT_USER_AGENT,
      },
      body: form.toString(),
    });

    const postAuthCookies = parseSetCookieHeaders(signinRes.headers);
    Object.assign(mergedCookies, postAuthCookies);

    const location = signinRes.headers.get("location") ?? "";
    const isChallengeOrBlocked =
      signinRes.status === 403 ||
      signinRes.status === 429 ||
      location.includes("captcha") ||
      location.includes("challenge");

    const isInvalidCredentials =
      signinRes.status === 401 ||
      location.includes("error=") ||
      location.includes("invalid");

    if (
      !isChallengeOrBlocked &&
      !isInvalidCredentials &&
      (signinRes.status === 200 ||
        signinRes.status === 302 ||
        signinRes.status === 303) &&
      (mergedCookies["__Http-typst-session"] || mergedCookies["typst-session"])
    ) {
      this.cookies = mergedCookies;
      this.authMethod = "api-password";
      this.email = email;
      this.saveStoredSession();
      return {
        authenticated: true,
        authMethod: "api-password",
        email,
        cookieNames: Object.keys(this.cookies),
      };
    }

    // Step 3: Automatic fallback to cookie or browser session if Turnstile/CAPTCHA challenge occurs
    if (
      options.useBrowserFallback !== false &&
      (isChallengeOrBlocked || !this.hasSession())
    ) {
      if (sessionCookie) {
        this.setSessionCookie(sessionCookie, email);
        return {
          authenticated: this.hasSession(),
          authMethod: "cookie",
          email,
          cookieNames: Object.keys(this.cookies),
        };
      }
      const fallbackRunner =
        this.browserFallbackFn ?? defaultPlaywrightBrowserFallback;
      if (fallbackRunner) {
        const fallbackCookies = await fallbackRunner(
          this.appUrl,
          this.apiUrl,
          email,
          password
        );
        this.cookies = { ...mergedCookies, ...fallbackCookies };
        this.authMethod = "browser-fallback";
        this.email = email;
        this.saveStoredSession();
        return {
          authenticated: this.hasSession(),
          authMethod: "browser-fallback",
          email,
          cookieNames: Object.keys(this.cookies),
        };
      }
    }

    let redirectDetail = "";
    if (location) {
      redirectDetail = `, redirect: ${location}`;
    }
    throw new Error(
      `Sign-in failed (HTTP ${signinRes.status}${redirectDetail}). Verify TYPST_EMAIL/TYPST_PASSWORD or supply TYPST_SESSION_COOKIE.`
    );
  }
}

export const defaultPlaywrightBrowserFallback: BrowserLoginFallbackFn = async (
  appUrl,
  _apiUrl,
  email,
  password
) => {
  const { spawnSync } = await import("node:child_process");
  const pyScript = `
import json, os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()
    page.goto(os.environ["TYPST_FB_URL"] + "/signin/", wait_until="networkidle")
    page.fill("input[name='email']", os.environ["TYPST_FB_EMAIL"])
    page.fill("input[name='password']", os.environ["TYPST_FB_PASS"])
    page.click("input[type='submit']")
    page.wait_for_load_state("networkidle")
    cookies = {c["name"]: c["value"] for c in ctx.cookies()}
    print(json.dumps(cookies))
    browser.close()
`;
  const proc = spawnSync("python", ["-c", pyScript], {
    env: {
      ...process.env,
      TYPST_FB_URL: appUrl,
      TYPST_FB_EMAIL: email,
      TYPST_FB_PASS: password,
    },
    encoding: "utf8",
    timeout: 30000,
  });
  if (proc.status !== 0 || !proc.stdout.trim()) {
    throw new Error(
      `Playwright browser fallback failed: ${proc.stderr || "no output"}`
    );
  }
  const lines = proc.stdout.trim().split(/\r\n|\n/);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, string>;
};
