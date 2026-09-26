import { DEPLOYMENT_LIMITS, limitExceededMessage } from "@easytestdata/shared/constants";

/**
 * Messages for the QuickBooks connect callback's error codes: `/home?error=<code>` redirects and
 * the popup's `{ error: <code> }` message.
 */
const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  connect_cancelled:
    "QuickBooks was not connected: access was cancelled or declined on the Intuit page. Connect again when you are ready.",
  state_invalid:
    "The QuickBooks connection link expired or was started in another browser. Please connect again.",
  not_team_member: "You are no longer a member of the team this connection was started for.",
  token_exchange_failed: "QuickBooks did not accept the authorization. Please connect again.",
  connection_limit_reached: limitExceededMessage(
    "connections",
    DEPLOYMENT_LIMITS.cloud.connections
  ),
  callback_failed: "Connecting QuickBooks failed. Please try again.",
  qbo_not_configured:
    "QuickBooks Online is not configured: the Intuit app keys are missing or could not be read."
};

/**
 * Toast text for a `?error=` code. Unknown codes get a generic message: the query string is
 * attacker-controlled, so it is never shown verbatim.
 */
export function connectErrorMessage(code: string): string {
  const known = Object.prototype.hasOwnProperty.call(CONNECT_ERROR_MESSAGES, code)
    ? CONNECT_ERROR_MESSAGES[code]
    : undefined;
  return known ?? "Something went wrong. Please try again.";
}
