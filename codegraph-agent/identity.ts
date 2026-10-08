import { auth, defineIdentity } from "managed-deepagents";

// Only the app's server calls the agent, with the workspace key it already
// holds for tracing. The key reaches the agent, not any analysis: what a run
// may read is the credential in its context.
export const identity = defineIdentity({ auth: auth.langsmithApiKey() });
