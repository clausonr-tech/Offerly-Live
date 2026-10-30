// The shape of one occurrence from a student's own class/club schedule, bulk-
// added as a "personal" event. No network calls, no external data — everything
// comes from the file the student uploads.

export type ParsedScheduleEvent = {
  title: string;
  isoDateTime: string; // "YYYY-MM-DDTHH:mm" on the student's clock; read it with parseWallClock, not new Date()
};
