// The Anthropic API key, shared by every function that calls Claude
// (see FIREBASE-SETUP.md).
import { defineSecret } from "firebase-functions/params";

export const anthropicKey = defineSecret("ANTHROPIC_API_KEY");
