/**
 * Utility for detecting supported image MIME types in Typst projects.
 */
export function detectSupportedImageMimeType(fileName: string): string | undefined {
  const ext = fileName.toLowerCase().split(".").pop();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    default:
      return undefined;
  }
}
