import { Point0 } from '@point0/core'

/**
 * The Point0 root for the SPA. Deliberately bare — no server middleware, no transformer: all data flows through plain
 * `fetch` to the package's party HTTP API, not through Point0 server loaders.
 */
export const root = Point0.lets.root().root()
