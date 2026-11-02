/**
 * Error taxonomy. Every error carries a `hint` the MCP layer passes to the
 * model, so a failure says what to do next rather than only what went wrong.
 */

export class AulaError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.hint = options?.hint;
  }
}

const LOGIN_HINT = 'Ask the user to run `aula-mcp login` in a terminal (MitID approval needed), then retry.';

/** No usable tokens: never logged in, refresh token expired or revoked. */
export class ReauthRequiredError extends AulaError {
  constructor(message: string, cause?: unknown) {
    super(message, { hint: LOGIN_HINT, cause });
  }
}

/** Login flow failures (MitID, broker, SAML). */
export class LoginError extends AulaError {}

/** STIL's bot protection intercepted the login chain. */
export class BotDefenseError extends LoginError {
  constructor(host: string) {
    super(
      `Login was intercepted by STIL's bot protection (${host}). It answers datacenter and hosting IPs with a JavaScript challenge that a plain HTTP client cannot pass.`,
      {
        hint: 'Log in from a home connection. Token refresh only talks to login.aula.dk, so the tokens keep working on a server afterwards (copy tokens.enc and set the same AULA_MCP_KEY).',
      },
    );
  }
}

/** Aula API error: HTTP status or a non-zero envelope status code. */
export class ApiError extends AulaError {
  readonly status: number;
  readonly code: number | undefined;
  readonly subCode: number | undefined;
  constructor(
    message: string,
    details: { status: number; code?: number; subCode?: number; hint?: string; cause?: unknown },
  ) {
    super(message, { hint: details.hint, cause: details.cause });
    this.status = details.status;
    this.code = details.code;
    this.subCode = details.subCode;
  }
}

/** Bad tool input the model can fix (unknown child, ambiguous name, bad range). */
export class InputError extends AulaError {}

export { LOGIN_HINT };
