// An error carrying an HTTP status, so routes can throw and the error
// middleware can answer with the right code.
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);
export const notFound = (msg) => new HttpError(404, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);
