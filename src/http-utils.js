// Small request/response helpers shared by every route module - pulled out
// of server.js verbatim when it was split into src/router.js + src/routes/*
// so each route module doesn't need to import server.js itself (that would
// create a circular import, since server.js is what wires the route modules
// together).

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // A syntactically valid but non-object JSON body (`null`, `42`, `"x"`, an
    // array) used to come back verbatim, and every route dereferences a field
    // straight off this return value with no guard of its own (e.g.
    // routes/sessions.js's `body.cwd`, routes/autopilot.js's
    // validateAgainstProviders) - so a literal `null` body 500'd as a
    // TypeError instead of 400ing like every other malformed body. Folding
    // the guard in here, next to the JSON.parse that already special-cases
    // failure, makes it safe everywhere at once instead of one call site at
    // a time.
    //
    // Invariant this creates: every caller gets back a plain object or {},
    // never a list or a scalar. A route whose body is legitimately an array
    // or a bare value cannot use this helper as-is - it would silently lose
    // that payload to the {} fallback - and needs its own parse instead.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function respondJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// `Authorization: Bearer <token>` is the primary path (what app.js sends);
// a `?token=` query param is accepted too, matching the ws upgrade's own
// convention, in case a future caller can't easily set headers.
export function extractToken(req, url) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return url.searchParams.get('token');
}
