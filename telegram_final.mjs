// Only a signal still present in the exact current final-results view may
// cause a Telegram message. Scores and technical candidates are not enough.
export function finalTelegramMatch(alert, currentFinalSignals, finalMinScore = 90) {
  if (!alert || !Array.isArray(currentFinalSignals) ||
      !Number.isInteger(finalMinScore) || finalMinScore < 90 || finalMinScore > 100) return null;
  return currentFinalSignals.find(row =>
    row?.decision?.ready === true &&
    row.status === 'signal' &&
    row.qualified === true &&
    Number.isFinite(row.score) && row.score >= finalMinScore && row.score <= 100 &&
    (row.direction === 'LONG' || row.direction === 'SHORT') &&
    row.symbol === alert.symbol &&
    row.direction === alert.direction &&
    row.pattern === alert.pattern &&
    row.time === alert.time &&
    row.patternConfirmedAt === alert.patternConfirmedAt
  ) || null;
}
