/** Terminal error handling: one JSON shape for every failure. */
export function notFound(req, res) {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
}

/** Wraps async handlers so rejections reach the error middleware (Express 5 does this too). */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
  return (err, req, res, next) => {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : (err?.status ?? 500);

    if (status >= 500) {
      logger.error(
        { err: err?.message, code: err?.code, stack: err?.stack, path: req.path },
        'request failed',
      );
    } else {
      logger.debug({ code: err?.code, path: req.path }, 'request rejected');
    }

    if (res.headersSent) {
      res.destroy();
      return;
    }

    // An explicit statusCode means the application *deliberately* raised this
    // error for the client (invalid URL, session cap, yt-dlp missing, ...), so
    // its message is safe and useful. Anything without one is an unexpected
    // internal failure and gets a generic reply.
    const intentional = Number.isInteger(err?.statusCode) || err?.expose === true;

    res.status(status).json({
      error: err?.code ?? (status >= 500 ? 'internal_error' : 'bad_request'),
      message: intentional
        ? (err?.message ?? 'Request failed.')
        : 'Something went wrong on the server.',
    });
  };
}
