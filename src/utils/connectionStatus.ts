/** Errors that mean a database session could not be opened or was lost. */
export function isConnectionFailure(message: string): boolean {
  return /\b(?:NJS-5\d{2}|NJS-003|DPI-1010|DPI-1080|ORA-(?:01012|01017|01033|01034|01089|01090|03113|03114|03135|12154|12170|125\d{2}|28000|28001)|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)\b/i.test(message)
    || /^(?:Failed to fetch|fetch failed|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(message);
}
