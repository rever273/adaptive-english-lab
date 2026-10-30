import type { FastifyError, FastifyInstance } from "fastify";
import type { ErrorEnvelope } from "@english-lab/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function envelope(requestId: string, code: string, message: string, details: unknown = null): ErrorEnvelope {
  return { error: { code, message, details, requestId } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send(envelope(req.id, err.code, err.message, err.details));
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send(envelope(req.id, "BAD_REQUEST", err.message));
    }
    req.log.error({ err: { name: err.name, message: err.message } }, "unhandled error");
    return reply.status(500).send(envelope(req.id, "INTERNAL", "Internal server error"));
  });
}
