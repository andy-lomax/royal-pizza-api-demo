import fs from "node:fs";

export function createAccountSessionStore(initialSessions = []) {
  return new Map(initialSessions);
}

function isSessionEntry(entry) {
  return (
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === "string" &&
    entry[0] &&
    entry[1] &&
    typeof entry[1] === "object" &&
    !Array.isArray(entry[1])
  );
}

export function restoreAccountSessions(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return createAccountSessionStore();
  }

  try {
    const parsed = JSON.parse(raw);
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];

    return createAccountSessionStore(sessions.filter(isSessionEntry));
  } catch {
    return createAccountSessionStore();
  }
}

export function serializeAccountSessions(sessions) {
  return JSON.stringify(
    {
      sessions: [...sessions.entries()],
    },
    null,
    2,
  );
}

export function loadAccountSessions(filePath) {
  try {
    return restoreAccountSessions(fs.readFileSync(filePath, "utf8"));
  } catch {
    return createAccountSessionStore();
  }
}

export function saveAccountSessions(filePath, sessions) {
  fs.writeFileSync(filePath, serializeAccountSessions(sessions));
}
