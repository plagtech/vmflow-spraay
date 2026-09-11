// Logging with a hard rule: a private key never reaches an output stream.
//
// The operator key is the one secret this worker holds, and the failure mode —
// a key in a log file on a vending operator's box — is unrecoverable. So every
// line is swept for key-shaped material before it is written, rather than
// trusting each call site to be careful.

const SECRET_ENV_NAMES = [
  "OPERATOR_PRIVATE_KEY",
  "SPRAAY_WALLET_PRIVATE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

/** 0x + 64 hex, i.e. a secp256k1 private key. Addresses (40 hex) are untouched. */
const PRIVATE_KEY_SHAPE = /\b(0x)?[0-9a-fA-F]{64}\b/g;

function redact(message: string): string {
  let output = message;

  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 8) {
      output = output.split(value).join(`<${name} redacted>`);
    }
  }

  // A 0x-prefixed 64-hex run is shape-identical to a tx hash, so shape alone
  // cannot tell them apart — the exact-value sweep above is what actually
  // guards the key. This is only a backstop for a key that reached the line
  // with its 0x stripped, where the tx-hash reading is the unlikely one; real
  // hashes keep their prefix through ethers and stay readable for the README.
  output = output.replace(PRIVATE_KEY_SHAPE, (match, prefix: string | undefined) =>
    prefix === "0x" ? match : "<64-hex redacted>",
  );

  return output;
}

function emit(stream: NodeJS.WriteStream, level: string, message: string): void {
  stream.write(`${new Date().toISOString()} ${level} ${redact(message)}\n`);
}

export const log = {
  info: (message: string): void => emit(process.stdout, "INFO ", message),
  warn: (message: string): void => emit(process.stderr, "WARN ", message),
  error: (message: string): void => emit(process.stderr, "ERROR", message),
};
