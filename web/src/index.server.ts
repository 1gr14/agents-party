// The Point0 server entry exists only so the engine config is complete; this SPA is served as a static client bundle
// by the package's own node:http server (src/server/http.ts), never by Point0. We never run `--side server`.
export {}
