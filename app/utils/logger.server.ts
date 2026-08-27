/**
 * Minimal structured JSON logger. One line per event; `event` is a stable
 * machine-readable name (e.g. "boot.database_healthy"), context goes in fields.
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function emit(level: Level, event: string, fields?: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(base: Fields): Logger;
}

function makeLogger(base: Fields = {}): Logger {
  return {
    debug: (event, fields) => emit("debug", event, { ...base, ...fields }),
    info: (event, fields) => emit("info", event, { ...base, ...fields }),
    warn: (event, fields) => emit("warn", event, { ...base, ...fields }),
    error: (event, fields) => emit("error", event, { ...base, ...fields }),
    child: (extra) => makeLogger({ ...base, ...extra }),
  };
}

export const logger: Logger = makeLogger();

/** Serialize an unknown thrown value into loggable fields. */
export function errorFields(error: unknown): Fields {
  if (error instanceof Error) return { error: error.message, stack: error.stack };
  return { error: String(error) };
}
