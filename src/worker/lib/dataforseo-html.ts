import { z } from "zod";

const TaskHtmlResponseSchema = z
  .object({
    status_message: z.string().optional(),
    tasks: z
      .array(
        z
          .object({
            status_message: z.string().optional(),
            result: z
              .array(
                z
                  .object({
                    items: z
                      .array(
                        z
                          .object({
                            page: z.number().optional(),
                            html: z.string().nullable().optional(),
                          })
                          .passthrough(),
                      )
                      .nullable()
                      .optional(),
                  })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export function extractTaskHtml(payload: unknown): string {
  const parsed = TaskHtmlResponseSchema.parse(payload);
  for (const task of parsed.tasks) {
    for (const result of task.result ?? []) {
      const item = [...(result.items ?? [])]
        .sort((left, right) => (left.page ?? 1) - (right.page ?? 1))
        .find((candidate) => candidate.html?.trim().length);
      if (item?.html) return item.html;
    }
  }
  const message =
    parsed.tasks.find((task) => task.status_message)?.status_message ??
    parsed.status_message ??
    "DataForSEO returned no HTML page";
  throw new Error(message);
}
