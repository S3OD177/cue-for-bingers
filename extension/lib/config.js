// Central configuration for the Bingers extension.

export const API_BASE = "https://api.bingers.app/v1";
export const AUTH_ISSUER = "https://api.bingers.app";

// OAuth 2.1 (PKCE) client. Bingers has no registration form: the client_id IS the
// HTTPS URL of a JSON client-metadata document you host (see /hosting/client-metadata.json).
// Replace this before publishing. Until it's replaced, the extension only offers
// personal-access-token sign-in.
export const OAUTH_CLIENT_ID = "https://YOUR-DOMAIN/bingers-extension/client-metadata.json";

export const OAUTH_SCOPES = "library:read library:write offline_access";
export const OAUTH_RESOURCE = "https://api.bingers.app/v1"; // tokens are audience-bound

// Where "Suggest this site" / "Report this page" emails go. The links stay hidden until this
// is set. Nothing is sent automatically: the user's mail app opens with a draft they can edit.
export const SUPPORT_EMAIL = "YOUR-SUPPORT-EMAIL";
export const supportEmailSet = () => !/YOUR-/.test(SUPPORT_EMAIL);

export const WEB_BASE = "https://bingers.app";
export const INTEGRATIONS_URL = "https://bingers.app/integrations";
