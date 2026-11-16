// Central configuration for the Bingers extension.

export const API_BASE = "https://api.bingers.app/v1";
export const AUTH_ISSUER = "https://api.bingers.app";

// OAuth 2.1 (PKCE) client. Bingers has no registration form: the client_id IS the
// HTTPS URL of a JSON client-metadata document you host (see /hosting/client-metadata.json).
// Hosted on GitHub Pages from /hosting (see .github/workflows/pages.yml). If it is set back
// to a YOUR-DOMAIN placeholder, the extension only offers personal-access-token sign-in.
export const OAUTH_CLIENT_ID = "https://s3od177.github.io/cue-for-bingers/client-metadata.json";

export const OAUTH_SCOPES = "library:read library:write offline_access";
export const OAUTH_RESOURCE = "https://api.bingers.app/v1"; // tokens are audience-bound

// Where "Suggest it" / "Report" go: a Google Form owned by the developer (responses land in
// its Sheet). One click, no sign-in for the user. The buttons stay hidden until this is set.
// Setup: README › "Site reports". action = the form's .../formResponse URL; fields = entry IDs.
export const REPORT_FORM = {
  action: "https://docs.google.com/forms/d/e/1FAIpQLScbSwNLU_BwLQFLKn3qMFkH8wD7B5yV5EoJBKTSliqh6azd8w/formResponse",
  fields: { subject: "entry.101647884", details: "entry.2130663153", version: "entry.687878420" },
};
export const reportsEnabled = () => !/YOUR[-_]/.test(JSON.stringify(REPORT_FORM));

export const WEB_BASE = "https://bingers.app";
export const INTEGRATIONS_URL = "https://bingers.app/integrations";
