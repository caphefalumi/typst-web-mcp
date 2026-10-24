import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { TypstLoadError } from "./errors.js";

export interface TypstDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  hints: string[];
}

export interface PreviewScreenshotItem {
  page: number;
  path: string;
  sizeBytes: number;
  pngSignatureValid: boolean;
  base64?: string;
}

export function resolveTypstBinary(explicitBin?: string): string {
  if (explicitBin) {
    return explicitBin;
  }
  if (process.env.TYPST_BIN) {
    return process.env.TYPST_BIN;
  }

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

function hasValidPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function optionalBase64(bytes: Buffer, includeBase64?: boolean): string | undefined {
  if (includeBase64) {
    return bytes.toString("base64");
  }
  return undefined;
}

function resolveOutputDirectory(
  configuredDir: string | undefined,
  prefix: string
): string {
  if (configuredDir) {
    return resolve(configuredDir);
  }
  return mkdtempSync(join(tmpdir(), prefix));
}

function normalizeDiagnosticPath(
  diagPath: string,
  workspaceDir: string
): string {
  const normalizedWorkspace = workspaceDir.replace(/\\/g, "/");
  if (diagPath.startsWith(normalizedWorkspace)) {
    return diagPath.slice(normalizedWorkspace.length).replace(/^\/+/, "");
  }
  return diagPath;
}

export function parseShortDiagnostics(stderrText: string): TypstDiagnostic[] {
  const diagnostics: TypstDiagnostic[] = [];
  const lines = stderrText.split(/\r\n|\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(
      /^(.+):(\d+):(\d+):\s+(error|warning):\s+(.+)$/i
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

export function compileWorkspaceDiagnostics(params: {
  typstBin: string;
  projectId: string;
  workspaceDir: string;
  mainFileName: string;
}): {
  projectId: string;
  mainFile: string;
  success: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: TypstDiagnostic[];
} {
  const outPdf = join(params.workspaceDir, "__check__.pdf");
  const proc = spawnSync(
    params.typstBin,
    [
      "compile",
      "--diagnostic-format",
      "short",
      "--root",
      params.workspaceDir,
      join(params.workspaceDir, params.mainFileName),
      outPdf,
    ],
    {
      cwd: params.workspaceDir,
      encoding: "utf8",
    }
  );

  const combinedOutput = `${proc.stderr ?? ""}\n${proc.stdout ?? ""}`;
  const diagnostics = parseShortDiagnostics(combinedOutput).map((d) => ({
    ...d,
    path: normalizeDiagnosticPath(d.path, params.workspaceDir),
  }));

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning"
  ).length;

  return {
    projectId: params.projectId,
    mainFile: params.mainFileName,
    success: proc.status === 0 && errorCount === 0,
    errorCount,
    warningCount,
    diagnostics,
  };
}

export function compileWorkspacePdf(params: {
  typstBin: string;
  projectId: string;
  projectName: string;
  workspaceDir: string;
  mainFileName: string;
  outputPath?: string;
}): {
  projectId: string;
  mainFile: string;
  outputPath: string;
  sizeBytes: number;
  pdfHeader: string;
  diagnostics: TypstDiagnostic[];
} {
  const safeName =
    params.projectName.replace(/[^a-zA-Z0-9._-]+/g, "_") || params.projectId;
  let outputPath = join(tmpdir(), `${safeName}.pdf`);
  if (params.outputPath) {
    outputPath = resolve(params.outputPath);
  }
  mkdirSync(dirname(outputPath), { recursive: true });

  const proc = spawnSync(
    params.typstBin,
    [
      "compile",
      "--diagnostic-format",
      "short",
      "--root",
      params.workspaceDir,
      join(params.workspaceDir, params.mainFileName),
      outputPath,
    ],
    {
      cwd: params.workspaceDir,
      encoding: "utf8",
    }
  );

  const combinedOutput = `${proc.stderr ?? ""}\n${proc.stdout ?? ""}`;
  const diagnostics = parseShortDiagnostics(combinedOutput);

  if (proc.status !== 0) {
    const formattedDiagnostics =
      diagnostics
        .map((d) => `${d.path}:${d.line}:${d.column} ${d.message}`)
        .join("; ") || combinedOutput.trim();
    throw new TypstLoadError(
      ["EXPORT_COMPILATION_FAILED"],
      `Failed to compile PDF for ${params.mainFileName}: ${formattedDiagnostics}`
    );
  }

  const pdfBytes = readFileSync(outputPath);
  return {
    projectId: params.projectId,
    mainFile: params.mainFileName,
    outputPath,
    sizeBytes: pdfBytes.byteLength,
    pdfHeader: pdfBytes.subarray(0, 8).toString("utf8"),
    diagnostics,
  };
}

export function captureBrowserPreviewScreenshot(params: {
  appUrl: string;
  projectId: string;
  cookieHeader: string;
  mainFile?: string;
  outputDir?: string;
  ppi: number;
  includeBase64?: boolean;
}): {
  projectId: string;
  mode: "browser";
  mainFile: string;
  outputDir: string;
  ppi: number;
  pageCount: number;
  screenshots: PreviewScreenshotItem[];
  diagnostics: TypstDiagnostic[];
} {
  const outputDir = resolveOutputDirectory(
    params.outputDir,
    `typst-preview-ui-${params.projectId}-`
  );
  mkdirSync(outputDir, { recursive: true });
  const screenshotPath = join(outputDir, `typst-app-${params.projectId}.png`);

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
      TYPST_PREVIEW_APP_URL: params.appUrl,
      TYPST_PREVIEW_PROJ_ID: params.projectId,
      TYPST_PREVIEW_OUT: screenshotPath,
      TYPST_PREVIEW_COOKIE: params.cookieHeader,
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
  return {
    projectId: params.projectId,
    mode: "browser",
    mainFile: params.mainFile ?? "main.typ",
    outputDir,
    ppi: params.ppi,
    pageCount: 1,
    screenshots: [
      {
        page: 1,
        path: screenshotPath,
        sizeBytes: bytes.byteLength,
        pngSignatureValid: hasValidPngSignature(bytes),
        base64: optionalBase64(bytes, params.includeBase64),
      },
    ],
    diagnostics: [],
  };
}

export function captureWorkspacePageScreenshots(params: {
  typstBin: string;
  projectId: string;
  projectName: string;
  workspaceDir: string;
  mainFileName: string;
  outputDir?: string;
  pages?: string;
  ppi: number;
  includeBase64?: boolean;
}): {
  projectId: string;
  mode: "pages";
  mainFile: string;
  outputDir: string;
  ppi: number;
  pageCount: number;
  screenshots: PreviewScreenshotItem[];
  diagnostics: TypstDiagnostic[];
} {
  const safeName =
    params.projectName.replace(/[^a-zA-Z0-9._-]+/g, "_") || params.projectId;
  const outputDir = resolveOutputDirectory(
    params.outputDir,
    `typst-preview-${safeName}-`
  );
  mkdirSync(outputDir, { recursive: true });

  const outputTemplate = join(outputDir, "page-{0p}.png");
  const args = [
    "compile",
    "--format",
    "png",
    "--ppi",
    String(params.ppi),
    "--diagnostic-format",
    "short",
    "--root",
    params.workspaceDir,
  ];
  if (params.pages && params.pages !== "all") {
    args.push("--pages", params.pages);
  }
  args.push(join(params.workspaceDir, params.mainFileName), outputTemplate);

  const proc = spawnSync(params.typstBin, args, {
    cwd: params.workspaceDir,
    encoding: "utf8",
  });

  const combinedOutput = `${proc.stderr ?? ""}\n${proc.stdout ?? ""}`;
  const diagnostics = parseShortDiagnostics(combinedOutput);

  if (proc.status !== 0) {
    const formattedDiagnostics =
      diagnostics
        .map((d) => `${d.path}:${d.line}:${d.column} ${d.message}`)
        .join("; ") || combinedOutput.trim();
    throw new TypstLoadError(
      ["PREVIEW_SCREENSHOT_COMPILATION_FAILED"],
      `Failed to render PNG preview for ${params.mainFileName}: ${formattedDiagnostics}`
    );
  }

  const files = readdirSync(outputDir)
    .filter((f) => /^page-\d+\.png$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const screenshots: PreviewScreenshotItem[] = files.map((fileName, idx) => {
    const fullPath = join(outputDir, fileName);
    const bytes = readFileSync(fullPath);
    const pageMatch = fileName.match(/page-(\d+)\.png/i);
    let pageNum = idx + 1;
    if (pageMatch) {
      pageNum = Number.parseInt(pageMatch[1]!, 10);
    }
    return {
      page: pageNum,
      path: fullPath,
      sizeBytes: bytes.byteLength,
      pngSignatureValid: hasValidPngSignature(bytes),
      base64: optionalBase64(bytes, params.includeBase64),
    };
  });

  return {
    projectId: params.projectId,
    mode: "pages",
    mainFile: params.mainFileName,
    outputDir,
    ppi: params.ppi,
    pageCount: screenshots.length,
    screenshots,
    diagnostics,
  };
}
