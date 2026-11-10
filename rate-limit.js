export function pruneExpiredRequests(requestCounts, now, windowMs) {
  for (const [key, request] of requestCounts) {
    if (now - request.startedAt >= windowMs) requestCounts.delete(key);
  }
}
