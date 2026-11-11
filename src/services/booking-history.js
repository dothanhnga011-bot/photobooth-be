// One expiry rule for operational history and customer-data cleanup.
// Financial reports read the retained sale records without this filter.
export function expiredBookingHistory(now, ttlMs) {
  const cutoff = new Date(Number(now) - ttlMs);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(now);
  return {
    createdAt: { $lte: cutoff },
    status: { $in: ["pending", "confirmed", "completed", "cancelled"] },
    $and: [
      { $or: [{ captureEndsAt: null }, { captureEndsAt: { $lte: cutoff } }] },
      { $or: [{ paidAt: null }, { paidAt: { $lte: cutoff } }] },
      { $or: [{ codeExpiresAt: null }, { codeExpiresAt: { $lte: now } }] },
      { $or: [{ date: null }, { date: { $lte: today } }] },
    ],
  };
}

export const visibleBookingHistory = (now, ttlMs) => ({
  customerDataDeletedAt: null,
  $nor: [expiredBookingHistory(now, ttlMs)],
});
