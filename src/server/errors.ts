/**
 * Errors that carry their HTTP status. Domain code throws these for problems
 * the caller can act on; the API turns them into `{ error, code }` with that
 * status. Anything else that escapes a route is a server fault (500).
 *
 * - 400: the request itself is wrong (bad field, or it names a project/account that doesn't exist)
 * - 404: the thing in the URL doesn't exist
 * - 409: the request is fine but the current state doesn't allow it
 * - 413: the body is too big
 */
export class HttpError extends Error {
  readonly code: string;
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
    this.code = errorCode(status);
  }
}

const CODES: Record<number, string> = {
  400: "bad_request",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "too_large",
  426: "upgrade_required",
};

export const errorCode = (status: number) => CODES[status] ?? (status >= 500 ? "internal" : "error");

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const tooLarge = (message: string) => new HttpError(413, message);
