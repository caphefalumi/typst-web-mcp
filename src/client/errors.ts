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

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
