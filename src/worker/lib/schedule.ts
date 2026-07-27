import { Temporal } from "@js-temporal/polyfill";
import type { Schedule } from "../../shared/contracts";

function plainTime(value: string): Temporal.PlainTime {
  return Temporal.PlainTime.from(`${value}:00`);
}

export function calculateNextRun(
  schedule: Schedule,
  after = new Date(),
): string {
  const instant = Temporal.Instant.fromEpochMilliseconds(after.getTime());
  const zonedNow = instant.toZonedDateTimeISO(schedule.timezone);
  const time = plainTime(schedule.time);

  let date = zonedNow.toPlainDate();
  if (schedule.cadence === "weekly") {
    const targetTemporalDay = schedule.weekday === 0 ? 7 : schedule.weekday;
    const delta = (targetTemporalDay - date.dayOfWeek + 7) % 7;
    date = date.add({ days: delta });
  }

  let candidate = date.toZonedDateTime({
    timeZone: schedule.timezone,
    plainTime: time,
  });

  if (Temporal.ZonedDateTime.compare(candidate, zonedNow) <= 0) {
    candidate =
      schedule.cadence === "daily"
        ? candidate.add({ days: 1 })
        : candidate.add({ weeks: 1 });
  }

  return candidate.toInstant().toString();
}

export function scheduleFromRow(row: {
  schedule_cadence: string;
  schedule_time: string;
  schedule_timezone: string;
  schedule_weekday: number | null;
}): Schedule {
  if (row.schedule_cadence === "weekly") {
    return {
      cadence: "weekly",
      time: row.schedule_time,
      timezone: row.schedule_timezone,
      weekday: row.schedule_weekday ?? 1,
    };
  }
  return {
    cadence: "daily",
    time: row.schedule_time,
    timezone: row.schedule_timezone,
  };
}
