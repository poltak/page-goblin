/** The entry point of the Worker. */

import { handleRequest, type Env } from './handler'

export default {
    fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env),
}
