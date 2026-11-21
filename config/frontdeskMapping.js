// Maps RoomCare's outgoing event payload to the body FrontDeskFlow expects.
//
// PENDING: FrontDeskFlow has not published its API yet, so this passes RoomCare's own payload through
// unchanged. When the contract arrives, reshape it here (field names, nesting, status words) — the business
// logic that decides *when* to notify lives in services/pmsIntegrationService.js and does not change.
//
// `event.payload` is the CleaningCompleted payload (see buildCleaningCompleted).
export const mapOutgoingToFrontDesk = (event) => event.payload;
